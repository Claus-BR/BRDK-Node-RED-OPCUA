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
const { ClientFile } = require("node-opcua-file-transfer");
const { getExtraDataTypeManager, DataTypeExtractStrategy } = require("node-opcua-client-dynamic-extension-object");
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
    this.subscriptions  = new Map();   // configId → { subscription, monitoredItems: Map<nodeId, entry> }
    this.cmdQueue       = [];          // Messages queued while connecting
    this.currentStatus  = "";
    this.hasConnected   = false;
    this.isClosing      = false;
    this.lastActivity   = 0;          // Timestamp of last session activity

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
      const action = msg.action || msg.payload?.action;

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

    const SESSION_TIMEOUT_MS = 120000; // 2 minutes — used to detect server-initiated session timeouts

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
          requestedSessionTimeout: SESSION_TIMEOUT_MS,
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

      // Pre-load server type dictionaries so ExtensionObjects decode correctly
      try {
        setStatus("extracting datatypes");
        node.extraDataTypeManager = await getExtraDataTypeManager(node.session, DataTypeExtractStrategy.Both);
      } catch (err) {
        node.warn(`Failed to load type dictionaries: ${err.message}`);
      }

      setStatus("session active");
      node.lastActivity = Date.now();

      // Register session close handler
      node.session.on("session_closed", () => {
        if (!node.isClosing) {
          setStatus("session closed");
          node.session = null;
          node.subscriptions.clear();
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


      const WINDOW = 5000; // 5 seconds window to detect session timeout

      node.client.on("connection_lost", () => {
        if (node.isClosing) return;

        // Detect inactivity timeout: if no request was made within the
        // session timeout window, the server closed the session.
        // Don't reconnect — go idle and let the next message re-connect.
        const idleMs = Date.now() - node.lastActivity;
        if (idleMs >= SESSION_TIMEOUT_MS - WINDOW && idleMs <= SESSION_TIMEOUT_MS + WINDOW) {
          closeSession()
            .then(() => disconnectClient())
            .then(() => setStatusWithDetail("timed out", "idle too long, connection closed by server"));
          return;
        }

        setStatus("disconnected");
      });
    }

    /**
     * Replay all queued commands after session is established.
     */
    function replayCommandQueue() {
      const queued = node.cmdQueue.splice(0);
      for (const { msg, send, done } of queued) {
        const action = msg.action || msg.payload?.action;
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
        node.lastActivity = Date.now();
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
     * Creates an individual ClientMonitoredItem per item for full
     * per-item unsubscribe support.
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

        const subConfigId = msg.subscriptionId;
        const subscription = ensureSubscription(msg);
        const subItems = getSubMonitoredItems(subConfigId);
        setStatus("subscribing");

        const samplingInterval = resolveSamplingInterval(msg);
        const queueSize = resolveQueueSize(msg);
        const discardOldest = resolveDiscardOldest(msg);

        for (const item of items) {
          // Terminate existing monitored item if re-subscribing same nodeId
          const existing = subItems.get(item.nodeId);
          if (existing) {
            try { await existing.terminate(); } catch { /* may already be terminated */ }
          }

          const monitoredItem = opcua.ClientMonitoredItem.create(
            subscription,
            { nodeId: item.nodeId, attributeId: opcua.AttributeIds.Value },
            { samplingInterval, discardOldest, queueSize },
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
            setSubscribedStatus("value changed");
            node.send([outMsg, null, null]);
          });

          monitoredItem.on("err", (errStr) => {
            node.error(`Monitored item error: ${errStr}`, msg);
          });

          subItems.set(item.nodeId, monitoredItem);
        }

        setSubscribedStatus("ready");
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

        const subConfigId = msg.subscriptionId;
        const subscription = ensureSubscription(msg);
        const subItems = getSubMonitoredItems(subConfigId);
        setStatus("monitoring");

        const samplingInterval = resolveSamplingInterval(msg);
        const queueSize = resolveQueueSize(msg);
        const discardOldest = resolveDiscardOldest(msg);

        // Resolve deadband settings
        const dbType = msg.deadbandType;
        const dbValue = msg.deadbandValue;
        const deadbandType = dbType === "p"
          ? opcua.DeadbandType.Percent
          : opcua.DeadbandType.Absolute;

        for (const item of items) {
          // Terminate existing monitored item if re-subscribing same nodeId
          const existing = subItems.get(item.nodeId);
          if (existing) {
            try { await existing.terminate(); } catch { /* may already be terminated */ }
          }

          const monitoredItem = opcua.ClientMonitoredItem.create(
            subscription,
            { nodeId: item.nodeId, attributeId: opcua.AttributeIds.Value },
            {
              samplingInterval,
              discardOldest,
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
            setSubscribedStatus("value changed");
            node.send([outMsg, null, null]);
          });

          monitoredItem.on("err", (errStr) => {
            node.error(`Monitored item error: ${errStr}`, msg);
          });

          subItems.set(item.nodeId, monitoredItem);
        }

        setSubscribedStatus("ready");
        done();
      } catch (err) {
        handleActionError("subscription error", err, msg, done);
      }
    }

    /**
     * UNSUBSCRIBE — Terminate monitoring for items in `msg.items`.
     *
     * If `msg.subscriptionId` is set, only removes from that subscription.
     * Otherwise, removes the item from whichever subscription holds it.
     */
    async function actionUnsubscribe(msg, send, done) {
      const items = msg.items || [];
      const subConfigId = msg.subscriptionId;
      let count = 0;

      if (subConfigId && !node.subscriptions.has(subConfigId)) {
        node.warn("Subscription is not active — nothing to unsubscribe from");
        done();
        return;
      }

      for (const item of items) {
        // Determine which subscription(s) to search
        const targets = subConfigId
          ? [[subConfigId, node.subscriptions.get(subConfigId)]]
          : [...node.subscriptions.entries()];

        for (const [, subEntry] of targets) {
          if (!subEntry) continue;
          const monitoredItem = subEntry.monitoredItems.get(item.nodeId);
          if (monitoredItem) {
            try {
              await monitoredItem.terminate();
            } catch (err) {
              node.warn(`Unsubscribe error for ${item.nodeId}: ${err.message}`);
            }
            subEntry.monitoredItems.delete(item.nodeId);
            count++;
            break; // Only remove from the first matching subscription
          }
        }
      }

      msg.payload = `Unsubscribed ${count} item(s)`;

      // Auto-delete subscriptions that no longer have any monitored items
      for (const [configId, subEntry] of [...node.subscriptions.entries()]) {
        if (subEntry.monitoredItems.size === 0) {
          try { await subEntry.subscription.terminate(); } catch { /* may already be terminated */ }
          node.subscriptions.delete(configId);
        }
      }

      const total = totalMonitoredItems();
      if (total === 0) {
        setStatus("session active");
      } else {
        setSubscribedStatus("Unsubscribed");
      }
      send([msg, null, null]);
      done();
    }

    /**
     * DELETE SUBSCRIPTION — Terminate the entire subscription.
     */
    async function actionDeleteSubscription(msg, send, done) {
      try {
        if (!msg.subscriptionId) {
          node.warn("No subscription specified — select a Subscription config in the Action node");
          done();
          return;
        }
        if (!node.subscriptions.has(msg.subscriptionId)) {
          node.warn("Subscription is not active — nothing to delete");
          done();
          return;
        }
        await terminateSubscription(msg.subscriptionId);
        msg.payload = "Subscription deleted";
        const total = totalMonitoredItems();
        if (total === 0) {
          setStatus("session active");
        } else {
          setSubscribedStatus("deleted");
        }
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
     * BROWSE — Browse the address space with configurable depth.
     *
     * Uses session.browse() in a recursive loop controlled by msg.maxDepth.
     * Each reference is enriched with Value + DataType for Variable nodes.
     *
     * msg.maxDepth = 1 (default) → direct children only
     * msg.maxDepth = N           → recurse N levels deep
     * msg.collect  = true        → nested tree structure in msg.payload (output 1)
     * msg.collect  = false       → one flat message per reference (output 1)
     */
    async function actionBrowse(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("browsing");

        const startNodeId = resolveNodeId(msg) || "ns=0;i=85";
        const maxDepth = Number(msg.maxDepth) || 1;

        const tree = await browseLevel(startNodeId, 1, maxDepth);

        if (tree.length === 0) {
          msg.payload = [];
          send([msg, null, null]);
          setStatusWithDetail("browse done", "0 items");
          done();
          return;
        }

        if (msg.collect) {
          // Collect mode: nested tree structure
          msg.payload = tree;
          send([msg, null, null]);
        } else {
          // Stream mode: flatten tree and send one message per entry
          const flat = flattenTree(tree);
          for (const entry of flat) {
            send([{ topic: msg.topic, payload: entry }, null, null]);
          }
        }

        const count = countTreeNodes(tree);
        setStatusWithDetail("browse done", `${count} items`);
        done();
      } catch (err) {
        handleActionError("browse error", err, msg, done);
      }
    }

    /**
     * Recursively browse one level and return an array of enriched entries.
     * Each non-variable entry gets a `children` array populated by recursion.
     *
     * @param {string} nodeId   - NodeId to browse
     * @param {number} depth    - Current depth (1-based)
     * @param {number} maxDepth - Maximum depth to recurse
     * @returns {Promise<object[]>} Array of enriched browse entries
     */
    async function browseLevel(nodeId, depth, maxDepth) {
      const browseResult = await node.session.browse({
        nodeId,
        browseDirection: opcua.BrowseDirection.Forward,
        referenceTypeId: "HierarchicalReferences",
        includeSubtypes: true,
        resultMask: 0x3F,
      });

      const references = browseResult.references || [];
      const entries = [];

      for (const ref of references) {
        const entry = {
          browseName:     ref.browseName?.name || ref.browseName?.toString() || "",
          nodeId:         ref.nodeId.toString(),
          displayName:    ref.displayName?.text || "",
          nodeClass:      opcua.NodeClass[ref.nodeClass] || String(ref.nodeClass),
          typeDefinition: ref.typeDefinition?.toString() || "",
          isVariable:     ref.nodeClass === opcua.NodeClass.Variable,
          value:          null,
          dataType:       "",
          depth,
          children:       [],
        };

        // Read Value + DataType for Variable nodes
        if (ref.nodeClass === opcua.NodeClass.Variable) {
          try {
            const dataValues = await node.session.read([
              { nodeId: ref.nodeId, attributeId: opcua.AttributeIds.Value },
              { nodeId: ref.nodeId, attributeId: opcua.AttributeIds.DataType },
            ]);
            entry.value = dataValues[0]?.value?.value ?? null;
            if (dataValues[1]?.value?.value) {
              const dtNodeId = dataValues[1].value.value;
              entry.dataType = opcua.DataType[dtNodeId.value] || dtNodeId.toString();
            }
          } catch {
            // Some nodes may not support reading — keep null/empty
          }
        }

        // Recurse into non-variable nodes (objects/folders) if under max depth
        if (depth < maxDepth && ref.nodeClass !== opcua.NodeClass.Variable) {
          entry.children = await browseLevel(ref.nodeId.toString(), depth + 1, maxDepth);
        }

        entries.push(entry);
      }

      return entries;
    }

    /**
     * Flatten a browse tree into a flat array (for stream mode).
     * Removes the `children` property from each entry.
     */
    function flattenTree(tree) {
      const flat = [];
      for (const entry of tree) {
        const { children, ...rest } = entry;
        flat.push(rest);
        if (children && children.length > 0) {
          flat.push(...flattenTree(children));
        }
      }
      return flat;
    }

    /**
     * Count total nodes in a browse tree.
     */
    function countTreeNodes(tree) {
      let count = 0;
      for (const entry of tree) {
        count += 1;
        if (entry.children) {
          count += countTreeNodes(entry.children);
        }
      }
      return count;
    }

    /**
     * INFO — Read all attributes of one or more nodes.
     *
     * When `msg.items` is present, reads attributes for every item and
     * sends per-item on output 1, batch on output 3 (same pattern as read).
     * Falls back to single `msg.topic` for backward compatibility.
     */
    async function actionInfo(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("reading");

        // Multi-item path
        if (msg.items?.length) {
          const { items: _items, ...baseMsg } = msg;

          const results = [];
          for (const item of msg.items) {
            const attributes = await node.session.readAllAttributes(item.nodeId);
            results.push({ item, attributes });

            // Per-item message on output 1
            const itemMsg = {
              ...baseMsg,
              topic: item.nodeId,
              datatype: item.datatype,
              browseName: item.browseName,
              payload: attributes,
            };
            send([itemMsg, null, null]);
          }

          // Batch message on output 3
          const batchMsg = {
            topic: "info",
            items: results.map((r) => ({
              nodeId: r.item.nodeId,
              datatype: r.item.datatype,
              browseName: r.item.browseName,
              attributes: r.attributes,
            })),
            payload: results.map((r) => r.attributes),
          };
          send([null, null, batchMsg]);

          setStatusWithDetail("read done", `${results.length} items`);
          done();
          return;
        }

        // Single-node fallback
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
        const subConfigId = msg.subscriptionId;
        const subscription = ensureSubscription(msg);
        const subItems = getSubMonitoredItems(subConfigId);
        setStatus("subscribing");

        // Build event filter fields
        const baseFields = [
          "SourceName", "EventId", "ReceiveTime", "Severity",
          "Message", "ConditionName", "ConditionType",
        ];
        const customFields = msg.customEventFields || [];
        const allFields = [...baseFields, ...customFields];
        const eventFilter = opcua.constructEventFilter(allFields);

        const eventNodeId = resolveNodeId(msg) || "i=2253"; // Default: Server object
        const eventTypeIds = msg.eventTypeIds || "i=2041"; // Default: BaseEvent
        const discardOldest = resolveDiscardOldest(msg);

        const monitoredItem = opcua.ClientMonitoredItem.create(
          subscription,
          {
            nodeId: opcua.resolveNodeId(eventNodeId),
            attributeId: opcua.AttributeIds.EventNotifier,
          },
          {
            samplingInterval: 0,
            discardOldest,
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
          setSubscribedStatus("event received");
          node.send([outMsg, null, null]);
        });

        monitoredItem.on("err", (errStr) => {
          node.error(`Event monitor error: ${errStr}`, msg);
        });

        subItems.set(`event:${eventNodeId}`, monitoredItem);
        setSubscribedStatus("ready");
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
     * HISTORY — Read historical values or aggregates for one or more nodes.
     *
     * When `msg.items` is present, reads history for every item and sends
     * per-item on output 1, batch on output 3 (same pattern as read).
     * Falls back to a single node when no `msg.items` is present.
     */
    async function actionHistory(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        setStatus("reading");

        const start = msg.start ? new Date(msg.start) : new Date(Date.now() - 3600000);
        const end = msg.end ? new Date(msg.end) : new Date();
        const aggregate = msg.aggregate || "raw";
        const numValuesPerNode = msg.numValuesPerNode || 1000;
        const returnBounds = msg.returnBounds || false;
        const processingInterval = msg.processingInterval || 3600000;

        const aggregateMap = {
          min:           opcua.AggregateFunction.Minimum,
          max:           opcua.AggregateFunction.Maximum,
          ave:           opcua.AggregateFunction.Average,
          interpolative: opcua.AggregateFunction.Interpolative,
        };

        /**
         * Read history for a single nodeId.
         */
        async function readHistoryForNode(nodeId) {
          if (aggregate === "raw") {
            return node.session.readHistoryValue(
              nodeId, start, end,
              { numValuesPerNode, returnBounds }
            );
          }
          const aggregateFn = aggregateMap[aggregate] || opcua.AggregateFunction.Average;
          return node.session.readAggregateValue(
            { nodeId }, start, end, aggregateFn, processingInterval
          );
        }

        // Multi-item path
        if (msg.items?.length) {
          const { items: _items, ...baseMsg } = msg;

          const results = [];
          for (const item of msg.items) {
            const result = await readHistoryForNode(item.nodeId);
            results.push({ item, result });

            // Per-item message on output 1
            const itemMsg = {
              ...baseMsg,
              topic: item.nodeId,
              datatype: item.datatype,
              browseName: item.browseName,
              payload: result,
            };
            send([itemMsg, null, null]);
          }

          // Batch message on output 3
          const batchMsg = {
            topic: "history",
            items: results.map((r) => ({
              nodeId: r.item.nodeId,
              datatype: r.item.datatype,
              browseName: r.item.browseName,
              history: r.result,
            })),
            payload: results.map((r) => r.result),
          };
          send([null, null, batchMsg]);

          setStatusWithDetail("read done", `${results.length} items`);
          done();
          return;
        }

        // Single-node fallback
        const nodeId = resolveNodeId(msg);
        const result = await readHistoryForNode(nodeId);

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
     *
     * Uses `msg.items` to extract the list of nodeIds to register.
     */
    async function actionRegister(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to register — msg.items is empty or missing");
          done();
          return;
        }

        const nodeIds = items.map((item) => item.nodeId);
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
     *
     * Uses `msg.items` to extract the list of nodeIds to unregister.
     */
    async function actionUnregister(msg, send, done) {
      if (!assertSession(msg, done)) return;

      try {
        const items = msg.items;
        if (!items?.length) {
          node.warn("No items to unregister — msg.items is empty or missing");
          done();
          return;
        }

        const nodeIds = items.map((item) => item.nodeId);
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
     * Shared helper — full teardown, optional endpoint override, then reconnect.
     *
     * Used by both actionConnect and actionReconnect since the lifecycle is
     * identical: teardown → recreate client → establish session.
     *
     * @param {object} msg - The incoming message.
     */
    async function resetAndConnect(msg) {
      // If a dynamic endpoint is provided, update the endpoint
      if (msg.OpcUaEndpoint) {
        node.endpointNode = {
          ...node.endpointNode,
          ...msg.OpcUaEndpoint,
        };
      }

      // Full teardown
      await terminateSubscription();
      await closeSession();
      await disconnectClient();

      node.client = null;
      node.session = null;
      node.hasConnected = false;

      // Recreate client and connect — initializeClient only auto-connects
      // when connectOnStart is true, so we explicitly connect afterwards.
      await initializeClient();
      if (!node.session) {
        await connectAndCreateSession();
      }
    }

    /**
     * CONNECT — Dynamic connect (can change endpoint at runtime).
     * Supports msg.OpcUaEndpoint to override endpoint configuration.
     */
    async function actionConnect(msg, send, done) {
      try {
        await resetAndConnect(msg);
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
     * Supports msg.OpcUaEndpoint to override endpoint configuration.
     */
    async function actionReconnect(msg, send, done) {
      try {
        await resetAndConnect(msg);
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
     * Ensure a subscription exists for the given subscription config.
     *
     * Uses `msg.subscriptionId` to look up an `opcua-subscription` config node.
     * Each entry in `node.subscriptions` is:
     *   { subscription: ClientSubscription, monitoredItems: Map<nodeId, entry> }
     *
     * @param {object}  msg - The incoming message (must have msg.subscriptionId).
     * @returns {opcua.ClientSubscription} The resolved OPC UA subscription.
     */
    function ensureSubscription(msg) {
      const subConfigId = msg.subscriptionId;
      if (!subConfigId) {
        throw new Error("No subscription configured. Select a Subscription config node.");
      }

      const existing = node.subscriptions.get(subConfigId);
      if (existing) return existing.subscription;

      const subConfigNode = RED.nodes.getNode(subConfigId);
      if (!subConfigNode) {
        throw new Error(`Subscription config node "${subConfigId}" not found.`);
      }

      const params = {
        requestedPublishingInterval: subConfigNode.publishingInterval,
        requestedLifetimeCount: subConfigNode.lifetimeCount,
        requestedMaxKeepAliveCount: subConfigNode.maxKeepAliveCount,
        maxNotificationsPerPublish: subConfigNode.maxNotificationsPerPublish,
        publishingEnabled: true,
        priority: subConfigNode.priority,
      };

      const subscription = opcua.ClientSubscription.create(node.session, params);

      const subEntry = { subscription, monitoredItems: new Map() };
      node.subscriptions.set(subConfigId, subEntry);

      subscription.on("started", () => {
        // Status is set by the calling action (subscribe/monitor/events)
      });

      subscription.on("keepalive", () => {
        setSubscribedStatus("keepalive");
      });

      subscription.on("terminated", () => {
        node.subscriptions.delete(subConfigId);
        if (node.subscriptions.size === 0) {
          setStatus("terminated");
        }
      });

      subscription.on("error", (err) => {
        setStatus("subscription error");
        node.error(`Subscription error: ${err.message}`);
      });

      return subscription;
    }

    /**
     * Count total monitored items across all subscriptions.
     */
    function totalMonitoredItems() {
      let count = 0;
      for (const [, entry] of node.subscriptions) {
        count += entry.monitoredItems.size;
      }
      return count;
    }

    /**
     * Get the monitored items Map for a subscription config ID.
     * Returns undefined if the subscription doesn't exist.
     */
    function getSubMonitoredItems(subConfigId) {
      return node.subscriptions.get(subConfigId)?.monitoredItems;
    }

    /**
     * Get the sampling interval from the subscription config node.
     */
    function resolveSamplingInterval(msg) {
      const subConfigNode = RED.nodes.getNode(msg.subscriptionId);
      return subConfigNode?.samplingInterval || 1000;
    }

    /**
     * Get the queue size from the subscription config node.
     */
    function resolveQueueSize(msg) {
      const subConfigNode = RED.nodes.getNode(msg.subscriptionId);
      return subConfigNode?.queueSize || 10;
    }

    /**
     * Get the discardOldest flag from the subscription config node.
     */
    function resolveDiscardOldest(msg) {
      const subConfigNode = RED.nodes.getNode(msg.subscriptionId);
      return subConfigNode?.discardOldest !== false;
    }

    /**
     * Terminate subscription(s) and clean up monitored items.
     *
     * @param {string} [subConfigId] - If provided, terminate only that subscription.
     *                                  If omitted, terminate all subscriptions.
     */
    async function terminateSubscription(subConfigId) {
      if (subConfigId) {
        // Terminate a specific subscription
        const entry = node.subscriptions.get(subConfigId);
        if (entry) {
          try { await entry.subscription.terminate(); } catch { /* may already be terminated */ }
          node.subscriptions.delete(subConfigId);
        }
      } else {
        // Terminate all subscriptions
        for (const [, entry] of node.subscriptions) {
          try { await entry.subscription.terminate(); } catch { /* may already be terminated */ }
        }
        node.subscriptions.clear();
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
     * Uses `msg.items[0].nodeId` from the standard item pipeline.
     * Returns an empty string if no items are present.
     *
     * Warns when multiple items are provided since this function is
     * used by single-node actions that only process the first item.
     */
    function resolveNodeId(msg) {
      if (msg.items?.length > 1) {
        node.warn(
          `Action "${msg.action}" uses a single node — only the first item ` +
          `(${msg.items[0].nodeId}) will be used, ${msg.items.length - 1} item(s) ignored`
        );
      }
      return msg.items?.[0]?.nodeId || "";
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
     * Set a combined subscription status: "subscribed | N items | lastEvent".
     * Uses the "subscribed" status key (green dot) with a detail string.
     */
    function setSubscribedStatus(lastEvent) {
      const count = totalMonitoredItems();
      const detail = `${count} item(s) | ${lastEvent}`;
      setStatusWithDetail("subscribed", detail);
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
