/**
 * @file opcua-client.js
 * @description OPC UA Client node — the main workhorse of the library.
 *
 * Supports 20 actions via `msg.action` or node configuration:
 *
 *   CONNECTION:   connect, disconnect, reconnect
 *   DATA:         read, write
 *   SUBSCRIPTION: subscribe, monitor, unsubscribe, deletesubscription
 *   BROWSING:     browse, info
 *   METHODS:      method
 *   EVENTS:       events, acknowledge
 *   HISTORY:      history
 *   FILE:         readfile, writefile
 *   ADVANCED:     register, unregister, build (ExtensionObject)
 *
 * ─── Message format ────────────────────────────────────────────────────────────
 *
 *   Data actions (read, write, subscribe, monitor) expect `msg.items` — an
 *   array of `{ nodeId, datatype, browseName, value? }` objects produced by
 *   the opcua-item or opcua-smart-item nodes.  Single-item and multi-item
 *   operations use the same code path.
 *
 * ─── Architecture ──────────────────────────────────────────────────────────────
 *
 *   Input (msg)  ──►  Action Router  ──►  Action Handler  ──►  Output (msg)
 *                          │                                     │
 *                          │                                  3 outputs:
 *                          │                                  [0] Data results
 *                          ▼                                  [1] Status/errors
 *                    Command Queue                            [2] Batch results
 *                    (when connecting)
 *
 *   The node maintains a single persistent OPCUAClient + Session.
 *   Messages that arrive while connecting are queued and replayed.
 *
 * ─── Outputs ───────────────────────────────────────────────────────────────────
 *
 *   Output 1 — Data results (per-item messages for read; write status)
 *   Output 2 — Status & error notifications { error, endpoint, status }
 *   Output 3 — Batch results (all items from read in a single msg)
 */

"use strict";

const opcua = require("node-opcua");
const { NodeCrawler } = require("node-opcua-client-crawler");
const { ClientFile } = require("node-opcua-file-transfer");
const { readFileSync } = require("fs");

const { getClientCertificateManager } = require("../lib/opcua-certificate-manager");
const { getStatus, getStatusWithDetail } = require("../lib/opcua-status");
const converter = require("../lib/opcua-data-converter");
const {
  DEFAULT_CONNECTION_STRATEGY,
  resolveUserIdentity,
  resolveSecurityMode,
  resolveSecurityPolicy,
} = require("../lib/opcua-connection");

module.exports = function (RED) {

  // ═══════════════════════════════════════════════════════════════════════════
  //  NODE CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════════════════

  function OpcUaClientNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration from editor ──────────────────────────────────────
    this.endpointNode   = RED.nodes.getNode(config.endpoint);
    this.action         = config.action || "read";
    this.deadbandType   = config.deadbandtype || "a";
    this.deadbandValue  = Number(config.deadbandvalue) || 1;
    this.time           = Number(config.time) || 10;
    this.timeUnit       = config.timeUnit || "s";
    this.name           = config.name || "";

    // Transport settings
    this.useTransport     = config.useTransport === true;
    this.maxChunkCount    = Number(config.maxChunkCount) || 1;
    this.maxMessageSize   = Number(config.maxMessageSize) || 8192;
    this.receiveBufferSize = Number(config.receiveBufferSize) || 8192;
    this.sendBufferSize   = Number(config.sendBufferSize) || 8192;

    // Session settings
    this.keepSessionAlive = config.keepSessionAlive === true;
    this.connectOnStart   = config.connectOnStart !== false;  // default: true

    // Client identity
    this.applicationName = config.applicationName || "BRDK-NodeRED-OPCUA-Client";
    this.applicationUri  = config.applicationUri || "";

    // ── Internal state ─────────────────────────────────────────────────
    this.client       = null;          // OPCUAClient instance
    this.session      = null;          // ClientSession instance
    this.subscription = null;          // ClientSubscription instance
    this.monitoredItems = new Map();   // nodeId → ClientMonitoredItem
    this.cmdQueue       = [];          // Messages queued while connecting
    this.currentStatus  = "";
    this.hasConnected   = false;
    this.isClosing      = false;

    // ── Validate endpoint ──────────────────────────────────────────────
    if (!this.endpointNode) {
      setStatus("invalid endpoint");
      return;
    }

    // ── Start the client ───────────────────────────────────────────────
    initializeClient();

    // ═══════════════════════════════════════════════════════════════════
    //  INPUT HANDLER
    // ═══════════════════════════════════════════════════════════════════

    node.on("input", (msg, send, done) => {
      // Determine the action to perform
      const action = msg.action || msg.payload?.action || node.action;

      // If we don't have a valid session yet, queue the message
      if (shouldQueueMessage(action)) {
        node.cmdQueue.push({ msg, send, done });
        return;
      }

      // Route to the appropriate action handler
      routeAction(action, msg, send, done);
    });

    // ═══════════════════════════════════════════════════════════════════
    //  CLOSE HANDLER
    // ═══════════════════════════════════════════════════════════════════

    node.on("close", async (done) => {
      node.isClosing = true;
      try {
        await terminateSubscription();
        await closeSession();
        await disconnectClient();
      } catch (err) {
        node.warn(`Cleanup error: ${err.message}`);
      }
      done();
    });

    // ═══════════════════════════════════════════════════════════════════
    //  CLIENT LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Create the OPC UA client object (lightweight, no TCP connection).
     * Connection is deferred if connectOnStart is false.
     */
    async function initializeClient() {
      try {
        // Initialize certificate manager
        const certManager = getClientCertificateManager();
        await certManager.initialize();

        // Build client options
        const clientOptions = {
          applicationName: node.applicationName,
          applicationUri: node.applicationUri || undefined,
          clientCertificateManager: certManager,
          securityMode: resolveSecurityMode(node.endpointNode.securityMode),
          securityPolicy: resolveSecurityPolicy(node.endpointNode.securityPolicy),
          defaultSecureTokenLifetime: 200000,
          keepSessionAlive: node.keepSessionAlive,
          requestedSessionTimeout: 60000,
          endpointMustExist: false,
          connectionStrategy: DEFAULT_CONNECTION_STRATEGY,
        };

        // Add transport settings if enabled
        if (node.useTransport) {
          clientOptions.transportSettings = {
            maxChunkCount: node.maxChunkCount,
            maxMessageSize: node.maxMessageSize,
            receiveBufferSize: node.receiveBufferSize,
            sendBufferSize: node.sendBufferSize,
          };
        }

        // Create the client
        node.client = opcua.OPCUAClient.create(clientOptions);
        registerClientEventHandlers();
        
        setStatus("client created");

        // Connect immediately or wait for trigger
        if (node.connectOnStart) {
          await connectAndCreateSession();
        } else {
          setStatus("waiting");
        }

      } catch (err) {
        handleConnectionError(err);
      }
    }

    /**
     * Connect to the server and create a session.
     */
    async function connectAndCreateSession() {
      const endpointUrl = node.endpointNode.endpoint;

      setStatus("connecting");
      await node.client.connect(endpointUrl);

      setStatus("connected");
      node.hasConnected = true;

      const userIdentity = resolveUserIdentity(node.endpointNode);
      node.session = await node.client.createSession(userIdentity);

      setStatus("session active");

      // Register session close handler
      node.session.on("session_closed", () => {
        if (!node.isClosing) {
          setStatus("session closed");
          node.session = null;
          node.subscription = null;
          node.monitoredItems.clear();
        }
      });

      // Replay any queued commands
      replayCommandQueue();
    }

    /**
     * Register event handlers on the OPC UA client for reconnection.
     */
    function registerClientEventHandlers() {
      node.client.on("connection_reestablished", () => {
        if (node.isClosing) return;
        setStatus("re-established");

        // If session was lost, re-create it
        if (!node.session) {
          connectAndCreateSession().catch(handleConnectionError);
        }
      });

      node.client.on("backoff", (retryCount, delay) => {
        if (node.isClosing) return;
        const label = node.hasConnected ? "reconnecting" : "connecting";
        const delaySec = (delay / 1000).toFixed(1);
        setStatusWithDetail(label, `attempt ${retryCount}, retry in ${delaySec}s`);
      });

      node.client.on("start_reconnection", () => {
        if (node.isClosing) return;
        setStatus("reconnecting");
      });

      node.client.on("connection_lost", () => {
        if (node.isClosing) return;
        setStatus("disconnected");
      });
    }

    /**
     * Replay all queued commands after session is established.
     */
    function replayCommandQueue() {
      const queued = node.cmdQueue.splice(0);
      for (const { msg, send, done } of queued) {
        const action = msg.action || msg.payload?.action || node.action;
        routeAction(action, msg, send, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION ROUTER
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Route a message to the correct action handler.
     */
    function routeAction(action, msg, send, done) {
      const handlers = {
        read:                () => actionRead(msg, send, done),
        write:               () => actionWrite(msg, send, done),
        subscribe:           () => actionSubscribe(msg, send, done),
        monitor:             () => actionMonitor(msg, send, done),
        unsubscribe:         () => actionUnsubscribe(msg, send, done),
        deletesubscription:  () => actionDeleteSubscription(msg, send, done),
        browse:              () => actionBrowse(msg, send, done),
        events:              () => actionEvents(msg, send, done),
        info:                () => actionInfo(msg, send, done),
        build:               () => actionBuild(msg, send, done),
        register:            () => actionRegister(msg, send, done),
        unregister:          () => actionUnregister(msg, send, done),
        acknowledge:         () => actionAcknowledge(msg, send, done),
        history:             () => actionHistory(msg, send, done),
        readfile:            () => actionReadFile(msg, send, done),
        writefile:           () => actionWriteFile(msg, send, done),
        connect:             () => actionConnect(msg, send, done),
        disconnect:          () => actionDisconnect(msg, send, done),
        reconnect:           () => actionReconnect(msg, send, done),
        method:              () => actionMethod(msg, send, done),
      };

      const handler = handlers[action];
      if (handler) {
        handler();
      } else {
        node.error(`Unknown action: "${action}"`, msg);
        done();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Read / Write
    // ═══════════════════════════════════════════════════════════════════

    /**
     * READ — Read one or more node values from `msg.items`.
     *
     * Sends a per-item message on output 1 for each item read,
     * and a single batch message on output 3 with all results.
     */
    async function actionRead(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to read — msg.items is empty or missing");
          done();
          return;
        }

        setStatus("reading");

        const nodesToRead = items.map((item) => ({
          nodeId: item.nodeId,
          attributeId: opcua.AttributeIds.Value,
        }));

        const dataValues = await node.session.read(nodesToRead);

        // Send a per-item message on output 1 (strip items from output)
        const { items: _items, ...baseMsgRead } = msg;
        for (let i = 0; i < dataValues.length; i++) {
          const itemMsg = {
            ...baseMsgRead,
            topic: items[i].nodeId,
            datatype: items[i].datatype,
            browseName: items[i].browseName,
            payload: dataValues[i].value?.value,
            statusCode: dataValues[i].statusCode,
            sourceTimestamp: dataValues[i].sourceTimestamp,
            serverTimestamp: dataValues[i].serverTimestamp,
          };
          send([itemMsg, null, null]);
        }

        // Send a batch message on output 3
        const batchMsg = {
          topic: "read",
          items: items.map((item, i) => ({
            nodeId: item.nodeId,
            datatype: item.datatype,
            browseName: item.browseName,
            value: dataValues[i].value?.value,
            statusCode: dataValues[i].statusCode,
            sourceTimestamp: dataValues[i].sourceTimestamp,
            serverTimestamp: dataValues[i].serverTimestamp,
          })),
          payload: dataValues,
        };
        send([null, null, batchMsg]);

        setStatus("read done");
        done();
      } catch (err) {
        handleActionError("read error", err, msg, done);
      }
    }

    /**
     * WRITE — Write one or more node values from `msg.items`.
     *
     * Each item in `msg.items` must have a `value` property.
     */
    async function actionWrite(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to write — msg.items is empty or missing");
          done();
          return;
        }

        setStatus("writing");

        const writeValues = items.map((item) => ({
          nodeId: item.nodeId,
          attributeId: opcua.AttributeIds.Value,
          value: converter.buildDataValue(
            item.datatype,
            item.value,
            item.timestamp || msg.sourceTimestamp || msg.timestamp
          ),
        }));

        const statusCodes = await node.session.write(writeValues);

        // Strip items from output
        const { items: _items, ...baseMsgWrite } = msg;
        const writeResult = { ...baseMsgWrite, payload: statusCodes };
        setStatus("value written");
        send([writeResult, null, null]);
        done();
      } catch (err) {
        handleActionError("write error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Subscriptions
    // ═══════════════════════════════════════════════════════════════════

    /**
     * SUBSCRIBE — Subscribe to value changes on one or more nodes.
     *
     * Uses `msg.items` to determine which nodes to subscribe to.
     * For a single item, creates an individual ClientMonitoredItem.
     * For multiple items, creates a ClientMonitoredItemGroup.
     */
    async function actionSubscribe(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to subscribe — msg.items is empty or missing");
          done();
          return;
        }

        await ensureSubscription(msg);
        setStatus("subscribing");

        const samplingInterval = msg.interval || converter.toMilliseconds(node.time, node.timeUnit);
        const queueSize = msg.queueSize || 10;

        if (items.length === 1) {
          // Single item — individual monitored item
          const item = items[0];
          const monitoredItem = opcua.ClientMonitoredItem.create(
            node.subscription,
            { nodeId: item.nodeId, attributeId: opcua.AttributeIds.Value },
            { samplingInterval, discardOldest: true, queueSize },
            opcua.TimestampsToReturn.Both
          );

          monitoredItem.on("changed", (dataValue) => {
            const outMsg = {
              topic: item.nodeId,
              datatype: item.datatype,
              browseName: item.browseName,
              payload: dataValue.value?.value,
              statusCode: dataValue.statusCode,
              serverTimestamp: dataValue.serverTimestamp,
              sourceTimestamp: dataValue.sourceTimestamp,
              serverPicoseconds: dataValue.serverPicoseconds,
              sourcePicoseconds: dataValue.sourcePicoseconds,
            };
            setStatus("value changed");
            node.send([outMsg, null, null]);
          });

          monitoredItem.on("err", (errStr) => {
            node.error(`Monitored item error: ${errStr}`, msg);
          });

          node.monitoredItems.set(item.nodeId, monitoredItem);
        } else {
          // Multiple items — monitored item group
          await subscribeMultipleItems(items, msg, send);
        }

        setStatus("subscribed");
        done();
      } catch (err) {
        handleActionError("subscription error", err, msg, done);
      }
    }

    /**
     * MONITOR — Subscribe with deadband filtering on one or more nodes.
     *
     * Uses `msg.items` to determine which nodes to monitor.
     */
    async function actionMonitor(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to monitor — msg.items is empty or missing");
          done();
          return;
        }

        await ensureSubscription(msg);
        setStatus("monitoring");

        const samplingInterval = msg.interval || converter.toMilliseconds(node.time, node.timeUnit);
        const queueSize = msg.queueSize || 10;

        // Resolve deadband settings (msg overrides node config)
        const dbType = msg.deadbandType || node.deadbandType;
        const dbValue = msg.deadbandValue ?? node.deadbandValue;
        const deadbandType = dbType === "p"
          ? opcua.DeadbandType.Percent
          : opcua.DeadbandType.Absolute;

        for (const item of items) {
          const monitoredItem = opcua.ClientMonitoredItem.create(
            node.subscription,
            { nodeId: item.nodeId, attributeId: opcua.AttributeIds.Value },
            {
              samplingInterval,
              discardOldest: true,
              queueSize,
              filter: new opcua.DataChangeFilter({
                trigger: opcua.DataChangeTrigger.StatusValue,
                deadbandType,
                deadbandValue: dbValue,
              }),
            },
            opcua.TimestampsToReturn.Both
          );

          monitoredItem.on("changed", (dataValue) => {
            const outMsg = {
              topic: item.nodeId,
              datatype: item.datatype,
              browseName: item.browseName,
              payload: dataValue.value?.value,
              statusCode: dataValue.statusCode,
              serverTimestamp: dataValue.serverTimestamp,
              sourceTimestamp: dataValue.sourceTimestamp,
            };
            setStatus("value changed");
            node.send([outMsg, null, null]);
          });

          monitoredItem.on("err", (errStr) => {
            node.error(`Monitored item error: ${errStr}`, msg);
          });

          node.monitoredItems.set(item.nodeId, monitoredItem);
        }

        setStatus("monitoring");
        done();
      } catch (err) {
        handleActionError("subscription error", err, msg, done);
      }
    }

    /**
     * UNSUBSCRIBE — Terminate monitoring for items in `msg.items`.
     */
    async function actionUnsubscribe(msg, send, done) {
      const items = msg.items || [];

      for (const item of items) {
        const monitoredItem = node.monitoredItems.get(item.nodeId);
        if (monitoredItem) {
          try {
            await monitoredItem.terminate();
            node.monitoredItems.delete(item.nodeId);
          } catch (err) {
            node.warn(`Unsubscribe error for ${item.nodeId}: ${err.message}`);
          }
        }
      }

      msg.payload = `Unsubscribed from ${items.length} item(s)`;
      setStatus("subscribed");
      send([msg, null, null]);
      done();
    }

    /**
     * DELETE SUBSCRIPTION — Terminate the entire subscription.
     */
    async function actionDeleteSubscription(msg, send, done) {
      try {
        await terminateSubscription();
        msg.payload = "Subscription deleted";
        setStatus("session active");
        send([msg, null, null]);
      } catch (err) {
        node.warn(`Delete subscription error: ${err.message}`);
      }
      done();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Browse
    // ═══════════════════════════════════════════════════════════════════

    /**
     * BROWSE — Browse the address space using NodeCrawler.
     */
    async function actionBrowse(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("browsing");

        const nodeId = resolveNodeId(msg) || "RootFolder";
        const crawler = new NodeCrawler(node.session);
        const elements = [];

        crawler.on("browsed", (element) => {
          elements.push(element);

          // Send individual elements unless collect mode
          if (!msg.collect) {
            const elementMsg = {
              topic: msg.topic,
              payload: element,
            };
            node.send([elementMsg, null, null]);
          }
        });

        await crawler.read(opcua.resolveNodeId(nodeId));
        crawler.dispose();

        // In collect mode, send all elements as one message
        if (msg.collect) {
          msg.payload = elements;
          send([msg, null, null]);
        }

        setStatus("browse done");
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    /**
     * INFO — Read all attributes of a node.
     */
    async function actionInfo(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("reading");

        const nodeId = resolveNodeId(msg);
        const attributes = await node.session.readAllAttributes(nodeId);

        msg.payload = attributes;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("read error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Events
    // ═══════════════════════════════════════════════════════════════════

    /**
     * EVENTS — Subscribe to OPC UA events/alarms.
     */
    async function actionEvents(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        await ensureSubscription(msg, true);
        setStatus("subscribing");

        // Build event filter fields
        const baseFields = [
          "SourceName", "EventId", "ReceiveTime", "Severity",
          "Message", "ConditionName", "ConditionType",
        ];
        const customFields = msg.customEventFields || [];
        const allFields = [...baseFields, ...customFields];
        const eventFilter = opcua.constructEventFilter(allFields);

        const eventNodeId = msg.topic || "i=2253"; // Default: Server object
        const eventTypeIds = msg.eventTypeIds || "i=2041"; // Default: BaseEvent

        const monitoredItem = opcua.ClientMonitoredItem.create(
          node.subscription,
          {
            nodeId: opcua.resolveNodeId(eventNodeId),
            attributeId: opcua.AttributeIds.EventNotifier,
          },
          {
            samplingInterval: 0,
            discardOldest: true,
            queueSize: 100,
            filter: eventFilter,
          }
        );

        monitoredItem.on("changed", (eventFields) => {
          // Map field names to values
          const eventData = {};
          allFields.forEach((fieldName, i) => {
            const variant = eventFields[i];
            eventData[fieldName] = variant?.value ?? variant;
          });

          const outMsg = {
            topic: eventNodeId,
            payload: eventData,
            eventFields,
          };
          setStatus("event received");
          node.send([outMsg, null, null]);
        });

        monitoredItem.on("err", (errStr) => {
          node.error(`Event monitor error: ${errStr}`, msg);
        });

        node.monitoredItems.set(`event:${eventNodeId}`, monitoredItem);
        setStatus("subscribed");
        done();
      } catch (err) {
        handleActionError("subscription error", err, msg, done);
      }
    }

    /**
     * ACKNOWLEDGE — Acknowledge an alarm/condition.
     */
    async function actionAcknowledge(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("acknowledging");

        const conditionId = opcua.coerceNodeId(msg.conditionId);
        const eventId = msg.eventId;
        const comment = msg.comment || "Acknowledged from Node-RED";

        const statusCode = await node.session.acknowledgeCondition(
          conditionId,
          eventId,
          comment
        );

        msg.payload = statusCode;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — History
    // ═══════════════════════════════════════════════════════════════════

    /**
     * HISTORY — Read historical values or aggregates.
     */
    async function actionHistory(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("reading");

        const nodeId = resolveNodeId(msg);
        const start = msg.start ? new Date(msg.start) : new Date(Date.now() - 3600000);
        const end = msg.end ? new Date(msg.end) : new Date();
        const aggregate = msg.aggregate || "raw";

        let result;

        if (aggregate === "raw") {
          result = await node.session.readHistoryValue(
            nodeId,
            start,
            end,
            {
              numValuesPerNode: msg.numValuesPerNode || 1000,
              returnBounds: msg.returnBounds || false,
            }
          );
        } else {
          // Aggregate reads
          const aggregateMap = {
            min:           opcua.AggregateFunction.Minimum,
            max:           opcua.AggregateFunction.Maximum,
            ave:           opcua.AggregateFunction.Average,
            interpolative: opcua.AggregateFunction.Interpolative,
          };
          const aggregateFn = aggregateMap[aggregate] || opcua.AggregateFunction.Average;
          const processingInterval = msg.processingInterval || 3600000;

          result = await node.session.readAggregateValue(
            { nodeId },
            start,
            end,
            aggregateFn,
            processingInterval
          );
        }

        msg.payload = result;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("read error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — File Transfer
    // ═══════════════════════════════════════════════════════════════════

    /**
     * READ FILE — Read a file from an OPC UA File Transfer object.
     */
    async function actionReadFile(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("reading");

        const fileNodeId = resolveNodeId(msg);
        const file = new ClientFile(node.session, opcua.coerceNodeId(fileNodeId));
        const size = await file.size();
        const openMode = 1; // Read

        const handle = await file.open(openMode);
        const data = await file.read(handle, size);
        await file.close(handle);

        msg.payload = data;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("read error", err, msg, done);
      }
    }

    /**
     * WRITE FILE — Write a file to an OPC UA File Transfer object.
     */
    async function actionWriteFile(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("writing");

        const fileNodeId = resolveNodeId(msg);
        const file = new ClientFile(node.session, opcua.coerceNodeId(fileNodeId));

        // Read data from local file or msg.payload
        let data;
        if (msg.fileName) {
          data = readFileSync(msg.fileName);
        } else if (Buffer.isBuffer(msg.payload)) {
          data = msg.payload;
        } else {
          data = Buffer.from(String(msg.payload));
        }

        const openMode = 2; // Write
        const handle = await file.open(openMode);
        await file.write(handle, data);
        await file.close(handle);

        msg.payload = true;
        setStatus("value written");
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("write error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Method Call
    // ═══════════════════════════════════════════════════════════════════

    /**
     * METHOD — Call an OPC UA method.
     */
    async function actionMethod(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("calling method");

        const objectId = opcua.coerceNodeId(msg.objectId);
        const methodId = opcua.coerceNodeId(msg.methodId);

        // Build input arguments
        const inputArgs = (msg.inputArguments || []).map((arg) => {
          const dataType = converter.toOpcuaDataType(arg.dataType);
          const value = converter.coerceScalarValue(arg.dataType, arg.value);
          return new opcua.Variant({ dataType, value });
        });

        const callRequest = new opcua.CallMethodRequest({
          objectId,
          methodId,
          inputArguments: inputArgs,
        });

        const result = await node.session.call(callRequest);

        msg.result = result;
        msg.output = result.outputArguments;
        msg.payload = result.outputArguments?.length === 1
          ? result.outputArguments[0].value
          : result.outputArguments?.map((a) => a.value);

        setStatus("method executed");
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("method error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — ExtensionObject Build
    // ═══════════════════════════════════════════════════════════════════

    /**
     * BUILD — Construct an ExtensionObject from a type NodeId.
     */
    async function actionBuild(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const typeNodeId = resolveNodeId(msg);
        const extensionObject = await node.session.constructExtensionObject(
          opcua.coerceNodeId(typeNodeId),
          {}
        );

        // Merge payload properties over defaults
        if (msg.payload && typeof msg.payload === "object") {
          Object.assign(extensionObject, msg.payload);
        }

        msg.payload = extensionObject;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Register / Unregister
    // ═══════════════════════════════════════════════════════════════════

    /**
     * REGISTER — Register node IDs for faster repeated access.
     */
    async function actionRegister(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const nodeIds = Array.isArray(msg.payload) ? msg.payload : [msg.topic];
        const registeredNodes = await node.session.registerNodes(nodeIds);

        msg.payload = registeredNodes;
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    /**
     * UNREGISTER — Unregister previously registered nodes.
     */
    async function actionUnregister(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const nodeIds = Array.isArray(msg.payload) ? msg.payload : [msg.topic];
        await node.session.unregisterNodes(nodeIds);

        msg.payload = "Nodes unregistered";
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTION HANDLERS — Connection Control
    // ═══════════════════════════════════════════════════════════════════

    /**
     * CONNECT — Dynamic connect (can change endpoint at runtime).
     */
    async function actionConnect(msg, send, done) {
      try {
        // If a dynamic endpoint is provided, update the endpoint
        if (msg.OpcUaEndpoint) {
          node.endpointNode = {
            ...node.endpointNode,
            ...msg.OpcUaEndpoint,
          };
        }

        await disconnectClient();
        node.client = null;
        node.session = null;
        await initializeClient();

        msg.payload = "Connected";
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    /**
     * DISCONNECT — Disconnect from the server.
     */
    async function actionDisconnect(msg, send, done) {
      try {
        await terminateSubscription();
        await closeSession();
        await disconnectClient();

        msg.payload = "Disconnected";
        setStatus("disconnected");
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    /**
     * RECONNECT — Disconnect and re-establish the connection.
     */
    async function actionReconnect(msg, send, done) {
      try {
        await terminateSubscription();
        await closeSession();
        await disconnectClient();

        node.client = null;
        node.session = null;
        node.hasConnected = false;

        await initializeClient();

        msg.payload = "Reconnected";
        send([msg, null, null]);
        done();
      } catch (err) {
        handleActionError("error", err, msg, done);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SUBSCRIPTION HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Ensure a subscription exists (create one if it doesn't).
     *
     * @param {object}  msg          - The incoming message.
     * @param {boolean} [forEvents]  - Use event-optimized parameters.
     */
    async function ensureSubscription(msg, forEvents = false) {
      if (node.subscription) return;

      const interval = msg.interval || converter.toMilliseconds(node.time, node.timeUnit);
      const params = forEvents
        ? converter.buildEventSubscriptionParameters(interval)
        : converter.buildSubscriptionParameters(interval);

      node.subscription = opcua.ClientSubscription.create(node.session, params);

      node.subscription.on("started", () => {
        // Status is set by the calling action (subscribe/monitor/events)
      });

      node.subscription.on("keepalive", () => {
        setStatus("keepalive");
      });

      node.subscription.on("terminated", () => {
        setStatus("terminated");
        node.subscription = null;
        node.monitoredItems.clear();
      });

      node.subscription.on("error", (err) => {
        setStatus("subscription error");
        node.error(`Subscription error: ${err.message}`);
      });
    }

    /**
     * Subscribe to multiple items in a group.
     *
     * @param {Array} items - Array of { nodeId, datatype, browseName }.
     * @param {object} msg  - The original incoming message.
     * @param {Function} send - The send function.
     */
    async function subscribeMultipleItems(items, msg, send) {
      const samplingInterval = msg.interval || converter.toMilliseconds(node.time, node.timeUnit);

      const itemsToMonitor = items.map((item) => ({
        nodeId: item.nodeId,
        attributeId: opcua.AttributeIds.Value,
      }));

      const group = opcua.ClientMonitoredItemGroup.create(
        node.subscription,
        itemsToMonitor,
        { samplingInterval, discardOldest: true, queueSize: 10 },
        opcua.TimestampsToReturn.Both
      );

      group.on("changed", (monitoredItem, dataValue, index) => {
        const item = items[index];
        const outMsg = {
          topic: item.nodeId,
          datatype: item.datatype,
          payload: dataValue.value?.value,
          statusCode: dataValue.statusCode,
          serverTimestamp: dataValue.serverTimestamp,
          sourceTimestamp: dataValue.sourceTimestamp,
        };
        setStatus("value changed");
        node.send([outMsg, null, null]);
      });

      setStatus("subscribed");
    }

    /**
     * Terminate the current subscription and all monitored items.
     */
    async function terminateSubscription() {
      if (node.subscription) {
        try {
          await node.subscription.terminate();
        } catch {
          // Subscription may already be terminated
        }
        node.subscription = null;
        node.monitoredItems.clear();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SESSION & CLIENT HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Close the current session.
     */
    async function closeSession() {
      if (node.session) {
        try {
          await node.session.close(true);
        } catch {
          // Session may already be closed
        }
        node.session = null;
      }
    }

    /**
     * Disconnect the client.
     */
    async function disconnectClient() {
      if (node.client) {
        try {
          node.client.removeAllListeners();
          await node.client.disconnect();
        } catch {
          // Client may already be disconnected
        }
        node.client = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UTILITY HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Check whether a message should be queued (session not ready).
     */
    function shouldQueueMessage(action) {
      // Connection control actions should never be queued
      if (["connect", "disconnect", "reconnect"].includes(action)) return false;

      // If connectOnStart is false and session hasn't been established yet, trigger lazy connect
      if (!node.session && node.client && !node.connectOnStart && !node.hasConnected) {
        connectAndCreateSession().catch(handleConnectionError);
        return true; // Queue this message until session is ready
      }

      // Queue if no session or session is reconnecting
      if (!node.session) return true;
      if (node.session.isReconnecting) return true;

      return false;
    }

    /**
     * Assert that a valid session exists.  Reports an error if not.
     *
     * @returns {boolean} True if session is valid.
     */
    function assertSession(msg, done) {
      if (node.session && !node.session.isReconnecting) return true;

      setStatus("no session");
      node.error("No active OPC UA session", msg);
      done();
      return false;
    }

    /**
     * Resolve the OPC UA NodeId from the message.
     *
     * Supports:
     *  - `msg.topic` as a NodeId string (ns=2;s=...)
     *  - `msg.topic` with `datatype=` suffix (stripped)
     *  - `msg.topic` with `br=` prefix (browse path — not translated here)
     */
    function resolveNodeId(msg) {
      let topic = msg.topic || "";

      // Strip datatype suffix if present: "ns=2;s=Var datatype=Double"
      if (topic.includes("datatype=")) {
        topic = topic.split("datatype=")[0].trim();
      }

      // Strip semicolon-delimited datatype: "ns=2;s=Var;datatype=Int32"
      if (topic.includes(";datatype=")) {
        topic = topic.split(";datatype=")[0];
      }

      return topic;
    }

    // ─── Status helpers ──────────────────────────────────────────────

    /**
     * Set the node status and send a status message on output 2.
     */
    function setStatus(statusKey) {
      node.currentStatus = statusKey;
      const status = getStatus(statusKey);
      node.status(status);

      // Send status notification on output 2
      const isError = statusKey.includes("error") || statusKey === "disconnected" || statusKey === "terminated";
      const statusMsg = {
        payload: statusKey,
        error: isError ? statusKey : null,
        endpoint: node.endpointNode?.endpoint || "",
        status: statusKey,
      };
      node.send([null, statusMsg, null]);
    }

    /**
     * Set status with additional detail text and send on output 2.
     */
    function setStatusWithDetail(statusKey, detail) {
      node.currentStatus = statusKey;
      const status = getStatusWithDetail(statusKey, detail);
      node.status(status);

      // Send status notification on output 2
      const isError = statusKey.includes("error") || statusKey === "disconnected" || statusKey === "terminated";
      const statusMsg = {
        payload: statusKey,
        detail,
        error: isError ? statusKey : null,
        endpoint: node.endpointNode?.endpoint || "",
        status: statusKey,
      };
      node.send([null, statusMsg, null]);
    }

    /**
     * Handle an error from an action handler.
     */
    function handleActionError(statusKey, err, msg, done) {
      setStatus(statusKey);
      node.error(err.message, msg);
      done(err);
    }

    /**
     * Handle a connection error.
     */
    function handleConnectionError(err) {
      const message = err.message || String(err);
      if (message.includes("certificate")) {
        setStatus("invalid certificate");
      } else {
        setStatusWithDetail("error", message);
      }
      node.error(`Connection error: ${message}`);
    }
  }

  RED.nodes.registerType("opcua-client", OpcUaClientNode);
};
