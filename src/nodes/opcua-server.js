/**
 * @file opcua-server.js
 * @description OPC UA Server node — creates and manages an OPC UA server.
 *
 * Supports dynamic address space management via input messages:
 *
 *   msg.command — the server command to execute
 *   msg.items   — array of item objects for node-targeting commands
 *
 * COMMANDS:
 *   VARIABLES:    addVariable, deleteNode
 *   FOLDERS:      setFolder, addFolder
 *   METHODS:      addMethod, bindMethod
 *   ALARMS:       installDiscreteAlarm, installLimitAlarm
 *   FILES:        addFile
 *   HISTORY:      installHistorian
 *   NAMESPACES:   registerNamespace, getNamespaceIndex, getNamespaces
 *   USERS:        setUsers
 *   EXT OBJECTS:  addExtensionObject
 *   PERSISTENCE:  saveAddressSpace, loadAddressSpace, bindVariables
 *   LIFECYCLE:    restartOPCUAServer
 *
 * VARIABLE UPDATES (no command):
 *   msg.items — [{ nodeId, datatype, value, quality?, sourceTimestamp? }]
 *
 * ─── Outputs ───────────────────────────────────────────────────────────────────
 *   Output 1 — Session events, variable changes by clients, command results
 *   Variable-write notifications include: msg.items [{ nodeId, datatype, browseName, value }]
 */

"use strict";

const opcua = require("node-opcua");
const { ObjectIds } = require("node-opcua-constants");
const { installFileType } = require("node-opcua-file-transfer");
const { NodeCrawler } = require("node-opcua-client-crawler");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { getStatus, getStatusWithDetail } = require("../lib/opcua-status");
const converter = require("../lib/opcua-data-converter");

// Server certificate manager (separate from client PKI)
const envPaths = require("env-paths")("node-red-opcua", { suffix: "" });

module.exports = function (RED) {

  function OpcUaServerNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration from editor ──────────────────────────────────────
    this.port           = Number(process.env.SERVER_PORT || config.port) || 4840;
    this.name           = config.name || "";
    this.resourcePath   = config.endpoint || "";
    this.hostname       = config.hostname || "";
    this.usersFile      = config.users || "";
    this.nodesetDir     = config.nodesetDir || "";

    // Security options
    this.autoAcceptUnknownCertificate = config.autoAcceptUnknownCertificate !== false;
    this.registerToDiscovery          = config.registerToDiscovery === true;
    this.constructDefaultAddressSpace = config.constructDefaultAddressSpace !== false;
    this.allowAnonymous               = config.allowAnonymous !== false;
    this.sessionTimeout               = Number(config.sessionTimeout) || 30000;

    // Security modes
    this.endpointNone          = config.endpointNone !== false;
    this.endpointSign          = config.endpointSign !== false;
    this.endpointSignEncrypt   = config.endpointSignEncrypt !== false;

    // Security policies
    this.endpointBasic128Rsa15        = config.endpointBasic128Rsa15 !== false;
    this.endpointBasic256             = config.endpointBasic256 !== false;
    this.endpointBasic256Sha256       = config.endpointBasic256Sha256 !== false;
    this.endpointAes128Sha256RsaOaep  = config.endpointAes128Sha256RsaOaep === true;
    this.endpointAes256Sha256RsaPss   = config.endpointAes256Sha256RsaPss === true;

    // Operating limits
    this.maxNodesPerBrowse                          = Number(config.maxNodesPerBrowse) || 0;
    this.maxNodesPerHistoryReadData                  = Number(config.maxNodesPerHistoryReadData) || 0;
    this.maxNodesPerHistoryReadEvents                = Number(config.maxNodesPerHistoryReadEvents) || 0;
    this.maxNodesPerHistoryUpdateData                = Number(config.maxNodesPerHistoryUpdateData) || 0;
    this.maxNodesPerRead                             = Number(config.maxNodesPerRead) || 0;
    this.maxNodesPerWrite                            = Number(config.maxNodesPerWrite) || 0;
    this.maxNodesPerMethodCall                       = Number(config.maxNodesPerMethodCall) || 0;
    this.maxNodesPerRegisterNodes                    = Number(config.maxNodesPerRegisterNodes) || 0;
    this.maxNodesPerNodeManagement                   = Number(config.maxNodesPerNodeManagement) || 0;
    this.maxMonitoredItemsPerCall                    = Number(config.maxMonitoredItemsPerCall) || 0;
    this.maxNodesPerHistoryUpdateEvents              = Number(config.maxNodesPerHistoryUpdateEvents) || 0;
    this.maxNodesPerTranslateBrowsePathsToNodeIds    = Number(config.maxNodesPerTranslateBrowsePathsToNodeIds) || 0;

    // Transport settings
    this.maxConnectionsPerEndpoint = Number(config.maxConnectionsPerEndpoint) || 20;
    this.maxMessageSize            = Number(config.maxMessageSize) || 4096;
    this.maxBufferSize             = Number(config.maxBufferSize) || 4096;
    this.maxSessions               = Math.max(Number(config.maxSessions) || 20, 10);
    this.maxSubscriptionsPerSession = Number(config.maxSubscriptionsPerSession) || 50;

    // ── Internal state ─────────────────────────────────────────────────
    this.server        = null;
    this.vendorName    = null;
    this.currentFolder = null;
    this.variables     = {};       // "ns:name" → current value
    this.variablesTs   = {};       // "ns:name" → source timestamp
    this.variablesStatus = {};     // "ns:name" → StatusCode
    this.users         = [];       // User credentials array
    this.initialized   = false;
    this.isClosing     = false;

    // ── Load users from file ───────────────────────────────────────────
    loadUsersFromFile(node);

    // ── Start the server ───────────────────────────────────────────────
    startServer();

    // ═══════════════════════════════════════════════════════════════════
    //  INPUT HANDLER
    // ═══════════════════════════════════════════════════════════════════

    node.on("input", async (msg, send, done) => {
      if (!node.initialized || !node.server) {
        node.warn("Server not initialized yet, queuing is not supported");
        done();
        return;
      }

      try {
        const command = msg.command;

        if (command) {
          await handleCommand(command, msg, send, done);
        } else if (isVariableUpdate(msg)) {
          handleVariableUpdates(msg, send, done);
        } else {
          done();
        }
      } catch (err) {
        node.error(`Input handler error: ${err.message}`, msg);
        done(err);
      }
    });

    // ═══════════════════════════════════════════════════════════════════
    //  CLOSE HANDLER
    // ═══════════════════════════════════════════════════════════════════

    node.on("close", async (done) => {
      node.isClosing = true;
      try {
        if (node.server) {
          await node.server.shutdown(0);
          node.server.dispose();
          node.log("Server shut down");
        }
      } catch (err) {
        node.warn(`Server shutdown error: ${err.message}`);
      }
      node.server = null;
      node.vendorName = null;
      done();
    });

    // ═══════════════════════════════════════════════════════════════════
    //  SERVER LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════

    async function startServer() {
      try {
        setNodeStatus("creating client");

        // Initialize certificate managers
        const serverCertManager = new opcua.OPCUACertificateManager({
          rootFolder: path.join(envPaths.config, "ServerPKI"),
          automaticallyAcceptUnknownCertificate: node.autoAcceptUnknownCertificate,
        });
        await serverCertManager.initialize();

        const userCertManager = new opcua.OPCUACertificateManager({
          rootFolder: path.join(envPaths.config, "UserPKI"),
          automaticallyAcceptUnknownCertificate: true,
        });
        await userCertManager.initialize();

        // Build security modes
        const securityModes = [];
        if (node.endpointNone) securityModes.push(opcua.MessageSecurityMode.None);
        if (node.endpointSign) securityModes.push(opcua.MessageSecurityMode.Sign);
        if (node.endpointSignEncrypt) securityModes.push(opcua.MessageSecurityMode.SignAndEncrypt);

        // Build security policies
        const securityPolicies = [];
        if (node.endpointBasic128Rsa15) securityPolicies.push(opcua.SecurityPolicy.Basic128Rsa15);
        if (node.endpointBasic256) securityPolicies.push(opcua.SecurityPolicy.Basic256);
        if (node.endpointBasic256Sha256) securityPolicies.push(opcua.SecurityPolicy.Basic256Sha256);
        if (node.endpointAes128Sha256RsaOaep) securityPolicies.push(opcua.SecurityPolicy.Aes128_Sha256_RsaOaep);
        if (node.endpointAes256Sha256RsaPss) securityPolicies.push(opcua.SecurityPolicy.Aes256_Sha256_RsaPss);

        // Collect nodeset XML files
        const nodesetFiles = collectNodesetFiles(node);

        // Build server options
        const hostname = node.hostname || os.hostname();
        const serverOptions = {
          port: node.port,
          resourcePath: node.resourcePath ? `/${node.resourcePath}` : undefined,
          hostname: node.hostname || undefined,
          nodeset_filename: nodesetFiles,
          serverCertificateManager: serverCertManager,
          userCertificateManager: userCertManager,
          allowAnonymous: node.allowAnonymous,
          securityModes,
          securityPolicies,
          maxConnectionsPerEndpoint: node.maxConnectionsPerEndpoint,
          maxSessions: node.maxSessions,
          maxSubscriptionsPerSession: node.maxSubscriptionsPerSession,
          timeout: node.sessionTimeout,
          serverInfo: {
            applicationUri: opcua.makeApplicationUrn(hostname, "BRDK-NodeRED-OPCUA-Server"),
            productUri: "BRDK-NodeRED-OPCUA-Server",
            applicationName: { text: node.name || "BRDK Node-RED OPCUA Server", locale: "en" },
          },
          buildInfo: {
            buildNumber: "1.0.0",
            buildDate: new Date(),
          },
          serverCapabilities: {
            operationLimits: buildOperationLimits(node),
          },
          userManager: {
            isValidUser: (username, password) => isValidUser(username, password),
            getUserRoles: (username) => getUserRoles(username),
          },
          isAuditing: false,
          registerServerMethod: node.registerToDiscovery
            ? opcua.RegisterServerMethod.LDS
            : opcua.RegisterServerMethod.HIDDEN,
        };

        // Create and start server
        setNodeStatus("initialized");
        node.server = new opcua.OPCUAServer(serverOptions);
        await node.server.initialize();

        // Build default address space
        if (node.constructDefaultAddressSpace) {
          constructDefaultAddressSpace();
        }

        await node.server.start();
        node.initialized = true;

        // Install aggregate support on the server address space
        try {
          const addressSpace = node.server.engine.addressSpace;
          opcua.addAggregateSupport(addressSpace);
        } catch {
          // Not critical if this fails
        }

        // Register session event handlers
        registerSessionHandlers();

        const port = node.server.endpoints?.[0]?.port || node.port;
        setNodeStatus("running", `port ${port}`);
        node.log(`OPC UA Server running on port ${port}`);

      } catch (err) {
        setNodeStatus("error", err.message);
        node.error(`Server start failed: ${err.message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  COMMAND ROUTER
    // ═══════════════════════════════════════════════════════════════════

    async function handleCommand(command, msg, send, done) {
      const handlers = {
        restartOPCUAServer:   () => cmdRestartServer(msg, send, done),
        addVariable:          () => cmdAddVariable(msg, send, done),
        addFolder:            () => cmdAddFolder(msg, send, done),
        setFolder:            () => cmdSetFolder(msg, send, done),
        deleteNode:           () => cmdDeleteNode(msg, send, done),
        addEquipment:         () => cmdAddEquipment(msg, send, done),
        addPhysicalAsset:     () => cmdAddPhysicalAsset(msg, send, done),
        addMethod:            () => cmdAddMethod(msg, send, done),
        bindMethod:           () => cmdBindMethod(msg, send, done),
        installHistorian:     () => cmdInstallHistorian(msg, send, done),
        installDiscreteAlarm: () => cmdInstallDiscreteAlarm(msg, send, done),
        installLimitAlarm:    () => cmdInstallLimitAlarm(msg, send, done),
        addExtensionObject:   () => cmdAddExtensionObject(msg, send, done),
        addFile:              () => cmdAddFile(msg, send, done),
        registerNamespace:    () => cmdRegisterNamespace(msg, send, done),
        getNamespaceIndex:    () => cmdGetNamespaceIndex(msg, send, done),
        getNamespaces:        () => cmdGetNamespaces(msg, send, done),
        setUsers:             () => cmdSetUsers(msg, send, done),
        saveAddressSpace:     () => cmdSaveAddressSpace(msg, send, done),
        loadAddressSpace:     () => cmdLoadAddressSpace(msg, send, done),
        bindVariables:        () => cmdBindVariables(msg, send, done),
      };

      const handler = handlers[command];
      if (handler) {
        await handler();
      } else {
        node.warn(`Unknown OPC UA command: ${command}`);
        done();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VARIABLE UPDATES
    // ═══════════════════════════════════════════════════════════════════

    function handleVariableUpdates(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      handleItemsVariableUpdate(addressSpace, msg.items);
      done();
    }

    /**
     * Process variable updates from msg.items format.
     * Each item: { nodeId, datatype, value, browseName?, quality?, sourceTimestamp? }
     */
    function handleItemsVariableUpdate(addressSpace, items) {
      for (const item of items) {
        if (!item.nodeId || item.value === undefined) continue;

        const vnode = addressSpace.findNode(item.nodeId);
        if (!vnode) {
          node.warn(`Variable not found: ${item.nodeId}`);
          continue;
        }

        const key = deriveVariableKey(item.nodeId);
        const datatype = item.datatype || "Double";

        node.variables[key] = item.value;

        if (item.quality || item.sourceTimestamp) {
          const statusCode = resolveStatusCode(item.quality);
          const ts = item.sourceTimestamp ? new Date(item.sourceTimestamp) : new Date();
          node.variablesTs[key] = ts;
          node.variablesStatus[key] = statusCode;

          try {
            const session = new opcua.PseudoSession(addressSpace);
            const dataValue = converter.buildDataValue(datatype, item.value, ts, statusCode);
            session.write({
              nodeId: opcua.coerceNodeId(item.nodeId),
              attributeId: opcua.AttributeIds.Value,
              value: dataValue,
            });
          } catch (err) {
            node.warn(`PseudoSession write error for ${item.nodeId}: ${err.message}`);
          }
        } else {
          const builtValue = converter.buildDataValue(datatype, item.value);
          vnode.setValueFromSource(builtValue);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  COMMAND HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Restart the OPC UA server.
     */
    async function cmdRestartServer(msg, send, done) {
      setNodeStatus("reconnecting", "restarting");
      node.initialized = false;

      try {
        if (node.server) {
          node.server.engine.setShutdownReason("Restart command received");
          await node.server.shutdown(10000);
          node.server.dispose();
          node.server = null;
          node.vendorName = null;
        }

        await startServer();
        done();
      } catch (err) {
        setNodeStatus("error", err.message);
        node.error(`Restart failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add variable(s) to the address space.
     *
     * msg.items: [{ nodeId, datatype, value?, description?, browseName?, displayName? }]
     */
    function cmdAddVariable(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0) {
        node.warn("addVariable requires msg.items with at least one item (nodeId, datatype)");
        done();
        return;
      }

      const parentFolder = node.currentFolder || node.vendorName;
      if (!parentFolder) {
        node.warn("No parent folder set — use setFolder or constructDefaultAddressSpace");
        done();
        return;
      }

      try {
        const namespace = addressSpace.getOwnNamespace();
        const outputItems = [];

        for (const item of items) {
          if (!item.nodeId || !item.datatype) {
            node.warn("addVariable item missing nodeId or datatype, skipping");
            continue;
          }

          const varOpts = buildVariableOptions(addressSpace, item, msg);
          varOpts.componentOf = parentFolder;

          const itemNs = resolveNamespace(addressSpace, item.nodeId);
          const newVar = itemNs.addVariable(varOpts);

          // Store initial value
          const key = deriveVariableKey(item.nodeId);
          node.variables[key] = item.value ?? getDefaultForType(item.datatype);

          // Bind get/set callbacks
          bindVariableGetSet(newVar, key, item.datatype, send);

          outputItems.push({
            nodeId: newVar.nodeId.toString(),
            datatype: item.datatype,
            browseName: item.browseName || deriveNodeName(item.nodeId),
          });
        }

        msg.items = outputItems;
        send(msg);
        done();
      } catch (err) {
        node.error(`addVariable failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add folder(s) to the address space.
     *
     * msg.items: [{ nodeId, browseName?, displayName?, description? }]
     */
    function cmdAddFolder(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0) {
        node.warn("addFolder requires msg.items with at least one item (nodeId)");
        done();
        return;
      }

      const parentFolder = node.currentFolder || node.vendorName;
      if (!parentFolder) {
        node.warn("No parent folder set");
        done();
        return;
      }

      try {
        const namespace = addressSpace.getOwnNamespace();
        for (const item of items) {
          const name = item.browseName || deriveNodeName(item.nodeId);
          const folderOpts = {
            organizedBy: parentFolder,
            typeDefinition: "FolderType",
            browseName: name,
            displayName: item.displayName || name,
            nodeId: item.nodeId,
          };

          if (item.description) {
            folderOpts.description = item.description;
          }

          applyAccessControl(folderOpts, msg);
          const itemNs = resolveNamespace(addressSpace, item.nodeId);
          itemNs.addObject(folderOpts);
        }
        done();
      } catch (err) {
        node.error(`addFolder failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Set the current parent folder for subsequent addVariable/addFolder calls.
     */
    function cmdSetFolder(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const nodeId = msg.items?.[0]?.nodeId || msg.nodeId;

      if (!nodeId) {
        node.warn("setFolder requires msg.nodeId or msg.items[0].nodeId");
        done();
        return;
      }

      const folder = addressSpace.findNode(nodeId);
      if (folder) {
        node.currentFolder = folder;
      } else {
        node.warn(`Folder not found: ${nodeId}`);
      }
      done();
    }

    /**
     * Delete node(s) from the address space.
     *
     * msg.items: [{ nodeId }]  or  msg.nodeId for a single node
     */
    function cmdDeleteNode(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];
      const singleNodeId = msg.nodeId;

      if (items.length === 0 && !singleNodeId) {
        node.warn("deleteNode requires msg.nodeId or msg.items");
        done();
        return;
      }

      try {
        const nodeIds = items.length > 0
          ? items.map(i => i.nodeId)
          : [singleNodeId];

        for (const nid of nodeIds) {
          const nodeToDelete = addressSpace.findNode(nid);
          if (nodeToDelete) {
            addressSpace.deleteNode(nodeToDelete);
          } else {
            node.warn(`Node not found for deletion: ${nid}`);
          }
        }
        done();
      } catch (err) {
        node.error(`deleteNode failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add an Equipment object (DI namespace).
     */
    function cmdAddEquipment(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const name = msg.nodeName;

      if (!name || !node.vendorName) {
        node.warn("addEquipment requires msg.nodeName and a default address space");
        done();
        return;
      }

      try {
        const namespace = addressSpace.getOwnNamespace();
        namespace.addObject({
          organizedBy: node.vendorName,
          browseName: name,
          displayName: name,
          eventSourceOf: addressSpace.rootFolder.objects.server,
        });
        done();
      } catch (err) {
        node.error(`addEquipment failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add a PhysicalAsset object.
     */
    function cmdAddPhysicalAsset(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const name = msg.nodeName;

      if (!name || !node.vendorName) {
        node.warn("addPhysicalAsset requires msg.nodeName");
        done();
        return;
      }

      try {
        const namespace = addressSpace.getOwnNamespace();
        namespace.addObject({
          organizedBy: node.vendorName,
          browseName: name,
          displayName: name,
        });
        done();
      } catch (err) {
        node.error(`addPhysicalAsset failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add a method to the address space.
     */
    function cmdAddMethod(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parentNodeId = msg.parentNodeId;
      const methodName = msg.methodName || msg.browseName;
      const inputArgs = msg.inputArguments || [];
      const outputArgs = msg.outputArguments || [];

      if (!parentNodeId || !methodName) {
        node.warn("addMethod requires msg.parentNodeId and msg.methodName");
        done();
        return;
      }

      try {
        const parentNode = addressSpace.findNode(parentNodeId);
        if (!parentNode) {
          node.warn(`Parent node not found: ${parentNodeId}`);
          done();
          return;
        }

        const methodInputArgs = inputArgs.map((arg) => ({
          name: arg.name || "input",
          description: arg.text || "",
          dataType: toOpcuaDataType(arg.type || "String"),
        }));

        const methodOutputArgs = outputArgs.map((arg) => ({
          name: arg.name || "output",
          description: arg.text || "",
          dataType: toOpcuaDataType(arg.type || "String"),
        }));

        const namespace = addressSpace.getOwnNamespace();
        const method = namespace.addMethod(parentNode, {
          browseName: methodName,
          inputArguments: methodInputArgs,
          outputArguments: methodOutputArgs,
        });

        // Default implementation returns BadNotImplemented — use bindMethod to bind actual logic
        method.bindMethod((inputArguments, context, callback) => {
          callback(null, { statusCode: opcua.StatusCodes.BadNotImplemented });
        });

        done();
      } catch (err) {
        node.error(`addMethod failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Bind a function to an existing method.
     */
    function cmdBindMethod(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const methodNodeId = msg.items?.[0]?.nodeId || msg.nodeId;
      const methodFunc = msg.code;

      if (!methodNodeId || !methodFunc) {
        node.warn("bindMethod requires msg.nodeId and msg.code (function)");
        done();
        return;
      }

      try {
        const method = addressSpace.findNode(methodNodeId);
        if (!method) {
          node.warn(`Method not found: ${methodNodeId}`);
          done();
          return;
        }

        method.bindMethod(methodFunc);
        done();
      } catch (err) {
        node.error(`bindMethod failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Install historian on variable(s).
     *
     * msg.items: [{ nodeId }]
     */
    function cmdInstallHistorian(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0) {
        node.warn("installHistorian requires msg.items with nodeId(s)");
        done();
        return;
      }

      try {
        for (const item of items) {
          const variable = addressSpace.findNode(item.nodeId);
          if (!variable) {
            node.warn(`Variable not found for historian: ${item.nodeId}`);
            continue;
          }

          addressSpace.installHistoricalDataNode(variable, {
            maxOnlineValues: 1000,
          });
        }
        done();
      } catch (err) {
        node.error(`installHistorian failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Install a discrete (boolean) alarm on variable(s).
     *
     * msg.items: [{ nodeId }], msg.priority, msg.alarmText
     */
    function cmdInstallDiscreteAlarm(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0) {
        node.warn("installDiscreteAlarm requires msg.items with nodeId(s)");
        done();
        return;
      }

      try {
        const severity = msg.priority || 100;

        for (const item of items) {
          const nodeId = item.nodeId;
          const parentNode = addressSpace.findNode(nodeId);
          if (!parentNode) {
            node.warn(`Node not found: ${nodeId}`);
            continue;
          }

          const name = deriveNodeName(nodeId);
          const alarmText = msg.alarmText || `Alarm on ${name}`;

          const namespace = addressSpace.getOwnNamespace();

          // Create a Boolean "AlarmState" variable
          const alarmStateVar = namespace.addVariable({
            propertyOf: parentNode,
            browseName: `${name}AlarmState`,
            dataType: "Boolean",
            value: { dataType: opcua.DataType.Boolean, value: false },
          });

          // Create the DiscreteAlarm
          const alarm = namespace.instantiateDiscreteAlarm("DiscreteAlarmType", {
            componentOf: parentNode,
            browseName: `${name}DiscreteAlarm`,
            conditionSource: alarmStateVar,
            inputNode: alarmStateVar,
            optionals: ["Acknowledge", "ConfirmedState", "Confirm"],
          });

          // React to alarm state changes
          alarmStateVar.on("value_changed", (_event, dataValue) => {
            const active = dataValue.value.value;
            if (active) {
              alarm.activateAlarm();
              alarm.setAckedState(false);
              alarm.raiseNewCondition({
                severity,
                message: alarmText,
                quality: opcua.StatusCodes.GoodClamped,
                retain: true,
              });
            } else {
              alarm.deactivateAlarm();
            }
          });
        }

        done();
      } catch (err) {
        node.error(`installDiscreteAlarm failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Install a non-exclusive limit alarm (HH/H/L/LL) on variable(s).
     *
     * msg.items: [{ nodeId }], msg.priority, msg.alarmText, msg.hh/h/l/ll
     */
    function cmdInstallLimitAlarm(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0) {
        node.warn("installLimitAlarm requires msg.items with nodeId(s)");
        done();
        return;
      }

      try {
        const severity = msg.priority || 100;
        const hh = msg.hh ?? 90;
        const h  = msg.h  ?? 70;
        const l  = msg.l  ?? 30;
        const ll = msg.ll ?? 10;

        for (const item of items) {
          const nodeId = item.nodeId;
          const parentNode = addressSpace.findNode(nodeId);
          if (!parentNode) {
            node.warn(`Node not found: ${nodeId}`);
            continue;
          }

          const name = deriveNodeName(nodeId);
          const alarmText = msg.alarmText || `Limit alarm on ${name}`;

          const namespace = addressSpace.getOwnNamespace();

          // Create a Double "LimitState" variable
          let currentLimitValue = 0;
          const limitStateVar = namespace.addVariable({
            propertyOf: parentNode,
            browseName: `${name}LimitState`,
            dataType: "Double",
            value: {
              get: () => new opcua.Variant({ dataType: opcua.DataType.Double, value: currentLimitValue }),
              set: (v) => { currentLimitValue = v.value; return opcua.StatusCodes.Good; },
            },
          });

          // Create the NonExclusiveLimitAlarm
          const alarm = namespace.instantiateNonExclusiveLimitAlarm("NonExclusiveLimitAlarmType", {
            componentOf: parentNode,
            browseName: `${name}LimitAlarm`,
            conditionSource: limitStateVar,
            inputNode: limitStateVar,
            highHighLimit: hh,
            highLimit: h,
            lowLimit: l,
            lowLowLimit: ll,
            optionals: ["Acknowledge", "ConfirmedState", "Confirm"],
          });

          // On value change, activate alarm
          limitStateVar.on("value_changed", () => {
            alarm.activateAlarm();
            alarm.raiseNewCondition({
              severity,
              message: alarmText,
              quality: opcua.StatusCodes.Good,
              retain: true,
            });
          });
        }

        done();
      } catch (err) {
        node.error(`installLimitAlarm failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add an extension object variable.
     *
     * msg.items: [{ nodeId, typeId, browseName?, displayName? }]
     */
    function cmdAddExtensionObject(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = msg.items || [];

      if (items.length === 0 || !items[0].nodeId || !items[0].typeId) {
        node.warn("addExtensionObject requires msg.items[0] with nodeId and typeId");
        done();
        return;
      }

      try {
        const parentFolder = node.currentFolder || node.vendorName;
        const namespace = addressSpace.getOwnNamespace();
        const item = items[0];
        const name = item.browseName || deriveNodeName(item.nodeId);
        const typeId = opcua.coerceNodeId(item.typeId);
        const extObj = addressSpace.constructExtensionObject(typeId, {});

        namespace.addVariable({
          componentOf: parentFolder,
          browseName: name,
          displayName: item.displayName || name,
          nodeId: item.nodeId,
          dataType: typeId,
          value: {
            dataType: opcua.DataType.ExtensionObject,
            value: extObj,
          },
        });

        done();
      } catch (err) {
        node.error(`addExtensionObject failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add a file node with OPC UA file transfer support.
     *
     * msg.items: [{ nodeId }] or msg.nodeId, msg.fileName
     */
    function cmdAddFile(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const nodeId = msg.items?.[0]?.nodeId || msg.nodeId;
      const fileName = msg.fileName;

      if (!nodeId || !fileName) {
        node.warn("addFile requires nodeId (msg.items[0].nodeId or msg.nodeId) and msg.fileName");
        done();
        return;
      }

      try {
        const parentFolder = node.currentFolder || node.vendorName;
        const namespace = addressSpace.getOwnNamespace();
        const name = deriveNodeName(nodeId);

        // Instantiate a FileType node, then install file transfer support
        const fileType = addressSpace.findObjectType("FileType");
        const fileNode = fileType.instantiate({
          organizedBy: parentFolder,
          browseName: name || fileName,
          nodeId: nodeId,
        });

        installFileType(fileNode, {
          filename: fileName,
          mimeType: "application/octet-stream",
        });

        done();
      } catch (err) {
        node.error(`addFile failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Register a new namespace.
     */
    function cmdRegisterNamespace(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const namespaceUri = msg.namespaceUri;

      if (!namespaceUri) {
        node.warn("registerNamespace requires msg.namespaceUri");
        done();
        return;
      }

      try {
        const ns = addressSpace.registerNamespace(namespaceUri);
        msg.payload = `ns=${ns.index}`;
        send(msg);
        done();
      } catch (err) {
        node.error(`registerNamespace failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Get the index of an existing namespace.
     */
    function cmdGetNamespaceIndex(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const namespaceUri = msg.namespaceUri;

      if (!namespaceUri) {
        node.warn("getNamespaceIndex requires msg.namespaceUri");
        done();
        return;
      }

      try {
        const ns = addressSpace.getNamespace(namespaceUri);
        msg.payload = ns ? `ns=${ns.index}` : "Namespace not found";
        send(msg);
        done();
      } catch (err) {
        node.error(`getNamespaceIndex failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Get all namespaces.
     */
    function cmdGetNamespaces(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const namespaces = {};

      for (let i = 0; i < addressSpace.getNamespaceArray().length; i++) {
        namespaces[addressSpace.getNamespaceArray()[i].namespaceUri] = i;
      }

      msg.payload = namespaces;
      send(msg);
      done();
    }

    /**
     * Set user credentials at runtime.
     */
    function cmdSetUsers(msg, send, done) {
      const newUsers = msg.users;

      if (!Array.isArray(newUsers)) {
        node.warn("setUsers requires msg.users as an array");
        done();
        return;
      }

      node.users = newUsers;
      node.log(`Users updated: ${newUsers.length} user(s)`);
      done();
    }

    /**
     * Save the address space to an XML file.
     */
    function cmdSaveAddressSpace(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const nsIndex = msg.namespaceIndex !== undefined ? parseInt(msg.namespaceIndex, 10) : 1;
      const filename = msg.filename || `addressSpace_ns${nsIndex}.xml`;

      try {
        const ns = addressSpace.getNamespaceArray()[nsIndex];
        if (!ns) {
          node.warn(`Namespace not found at index: ${nsIndex}`);
          done();
          return;
        }

        const xmlContent = ns.toNodeset2XML();
        fs.writeFileSync(filename, xmlContent, "utf8");
        msg.payload = `Address space saved to ${filename}`;
        send(msg);
        done();
      } catch (err) {
        node.error(`saveAddressSpace failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Load an address space from XML file and restart the server.
     */
    async function cmdLoadAddressSpace(msg, send, done) {
      const filename = msg.filename;

      if (!filename) {
        node.warn("loadAddressSpace requires msg.filename");
        done();
        return;
      }

      if (!fs.existsSync(filename)) {
        node.warn(`File not found: ${filename}`);
        done();
        return;
      }

      node.log(`Loading address space from ${filename} — server will restart`);
      // Store the file path for the next start cycle to load it as a nodeset
      node._loadedAddressSpaceFile = filename;
      await cmdRestartServer(msg, send, done);
    }

    /**
     * Bind get/set callbacks to all variables in the address space.
     */
    async function cmdBindVariables(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;

      try {
        const session = new opcua.PseudoSession(addressSpace);
        const crawler = new NodeCrawler(session);
        const results = [];

        crawler.on("browsed", (element) => {
          if (element.nodeId && element.nodeClass === opcua.NodeClass.Variable) {
            results.push({
              nodeId: element.nodeId.toString(),
              browseName: element.browseName?.toString() || "",
            });
          }
        });

        await crawler.read(opcua.resolveNodeId("RootFolder"));

        for (const item of results) {
          const vnode = addressSpace.findNode(item.nodeId);
          if (vnode && vnode.nodeClass === opcua.NodeClass.Variable) {
            try {
              const key = item.browseName || item.nodeId;
              bindVariableGetSet(vnode, key, "Double", node.send.bind(node));
            } catch {
              // Some nodes may not support binding
            }
          }
        }

        msg.payload = `Bound ${results.length} variables`;
        send(msg);
        done();
      } catch (err) {
        node.error(`bindVariables failed: ${err.message}`, msg);
        done(err);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DEFAULT ADDRESS SPACE
    // ═══════════════════════════════════════════════════════════════════

    function constructDefaultAddressSpace() {
      const addressSpace = node.server.engine.addressSpace;
      const namespace = addressSpace.getOwnNamespace();

      // Create vendor-specific root object
      node.vendorName = namespace.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: "VendorName",
        displayName: "Vendor Name",
        eventSourceOf: addressSpace.rootFolder.objects.server,
      });

      // Equipment and Physical Assets folders
      namespace.addObject({
        organizedBy: node.vendorName,
        browseName: "Equipment",
        displayName: "Equipment",
      });

      namespace.addObject({
        organizedBy: node.vendorName,
        browseName: "PhysicalAssets",
        displayName: "Physical Assets",
      });

      // Default variables
      const freeMemVar = namespace.addVariable({
        componentOf: node.vendorName,
        browseName: "FreeMemory",
        displayName: "Free Memory",
        nodeId: "s=FreeMemory",
        dataType: "Double",
        value: {
          get: () => new opcua.Variant({
            dataType: opcua.DataType.Double,
            value: os.freemem() / os.totalmem() * 100,
          }),
        },
      });

      let counterValue = 0;
      const counterVar = namespace.addVariable({
        componentOf: node.vendorName,
        browseName: "Counter",
        displayName: "Counter",
        nodeId: "s=Counter",
        dataType: "UInt32",
        value: {
          get: () => new opcua.Variant({
            dataType: opcua.DataType.UInt32,
            value: counterValue++,
          }),
        },
      });

      // Set default current folder
      node.currentFolder = node.vendorName;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SESSION TRACKING
    // ═══════════════════════════════════════════════════════════════════

    function registerSessionHandlers() {
      const server = node.server;

      server.on("create_session", (session) => {
        if (node.isClosing) return;
        node.send({
          topic: "Client-connected",
          payload: session.sessionName || "unknown",
        });
      });

      server.on("session_closed", (session, reason) => {
        if (node.isClosing) return;
        node.send({
          topic: "Client-disconnected",
          payload: session.sessionName || "unknown",
        });
      });

      server.on("session_activated", (session) => {
        if (node.isClosing) return;
        if (session.userIdentityToken?.userName) {
          node.send({
            topic: "Username",
            payload: session.userIdentityToken.userName,
          });
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  USER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    function isValidUser(username, password) {
      if (node.users.length === 0) return true; // No users configured = allow all
      return node.users.some((u) => u.username === username && u.password === password);
    }

    function getUserRoles(username) {
      const user = node.users.find((u) => u.username === username);

      if (!user) {
        return opcua.makeRoles([opcua.WellKnownRoles.AuthenticatedUser]);
      }

      if (user.roles) {
        return opcua.makeRoles(user.roles);
      }

      return opcua.makeRoles([opcua.WellKnownRoles.Anonymous]);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Bind get/set callbacks to a variable node.
     */
    function bindVariableGetSet(variableNode, key, datatype, sendFn) {
      const timestampedGet = function () {
        const value = node.variables[key];
        const ts = node.variablesTs[key] || new Date();
        const status = node.variablesStatus[key] || opcua.StatusCodes.Good;
        return new opcua.DataValue({
          value: converter.buildVariant(datatype, value),
          sourceTimestamp: ts,
          statusCode: status,
        });
      };

      const setCallback = function (dataValue) {
        const newValue = dataValue.value?.value;
        node.variables[key] = newValue;
        node.variablesTs[key] = dataValue.sourceTimestamp || new Date();

        // Notify downstream when a client writes
        if (sendFn) {
          sendFn({
            items: [{
              nodeId: variableNode.nodeId.toString(),
              datatype: datatype,
              browseName: key,
              value: newValue,
            }],
          });
        }

        return opcua.StatusCodes.Good;
      };

      variableNode.bindVariable({
        timestamped_get: timestampedGet,
        set: setCallback,
      });
    }

    /**
     * Set node status display.
     */
    function setNodeStatus(statusKey, detail) {
      const status = detail
        ? getStatusWithDetail(statusKey, detail)
        : getStatus(statusKey);
      node.status(status);
    }
  }

  RED.nodes.registerType("opcua-server", OpcUaServerNode);
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MODULE-LEVEL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load users from a JSON file.
 */
function loadUsersFromFile(node) {
  if (!node.usersFile) return;

  const candidates = [
    node.usersFile,
    path.join(process.cwd(), node.usersFile),
    path.join(process.cwd(), ".node-red", node.usersFile),
  ];

  for (const filepath of candidates) {
    try {
      if (fs.existsSync(filepath)) {
        const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
        node.users = Array.isArray(data) ? data : [];
        node.log(`Loaded ${node.users.length} user(s) from ${filepath}`);
        return;
      }
    } catch (err) {
      node.warn(`Failed to load users from ${filepath}: ${err.message}`);
    }
  }
}

/**
 * Collect nodeset XML files for the server.
 */
function collectNodesetFiles(node) {
  const files = [opcua.nodesets.standard];

  // Custom nodeset directory
  if (node.nodesetDir && fs.existsSync(node.nodesetDir)) {
    const customFiles = fs.readdirSync(node.nodesetDir)
      .filter((f) => f.endsWith(".xml"))
      .map((f) => path.join(node.nodesetDir, f));
    files.push(...customFiles);
  }

  // Previously saved address space
  if (node._loadedAddressSpaceFile && fs.existsSync(node._loadedAddressSpaceFile)) {
    files.push(node._loadedAddressSpaceFile);
  }

  return files;
}

/**
 * Build operation limits from node config.
 */
function buildOperationLimits(node) {
  const limits = {};
  const fields = [
    "maxNodesPerBrowse", "maxNodesPerHistoryReadData", "maxNodesPerHistoryReadEvents",
    "maxNodesPerHistoryUpdateData", "maxNodesPerRead", "maxNodesPerWrite",
    "maxNodesPerMethodCall", "maxNodesPerRegisterNodes", "maxNodesPerNodeManagement",
    "maxMonitoredItemsPerCall", "maxNodesPerHistoryUpdateEvents",
    "maxNodesPerTranslateBrowsePathsToNodeIds",
  ];

  for (const field of fields) {
    if (node[field] > 0) limits[field] = node[field];
  }

  return limits;
}

/**
 * Build variable options for addVariable.
 */
function buildVariableOptions(addressSpace, item, msg) {
  const datatype = item.datatype;
  const isArray = datatype.includes("Array");
  const baseType = datatype.replace("Array", "").replace(/\[.*\]/, "");
  const name = item.browseName || deriveNodeName(item.nodeId);

  const opts = {
    browseName: name,
    displayName: item.displayName || name,
    nodeId: item.nodeId,
    dataType: baseType,
    accessLevel: opcua.makeAccessLevelFlag("CurrentRead | CurrentWrite"),
    userAccessLevel: opcua.makeAccessLevelFlag("CurrentRead | CurrentWrite"),
    rolePermissions: [
      { roleId: opcua.WellKnownRoles.Anonymous, permissions: opcua.allPermissions },
      { roleId: opcua.WellKnownRoles.AuthenticatedUser, permissions: opcua.allPermissions },
    ],
    accessRestrictions: opcua.AccessRestrictionsFlag.None,
  };

  if (item.description) {
    opts.description = item.description;
  }

  // Handle array dimensions
  if (isArray) {
    const dimMatch = datatype.match(/\[([^\]]+)\]/);
    if (dimMatch) {
      const dims = dimMatch[1].split(",").map(Number);
      opts.valueRank = dims.length;
      opts.arrayDimensions = dims;
    } else {
      opts.valueRank = 1;
    }
  }

  // Apply access control from msg
  applyAccessControl(opts, msg);

  return opts;
}

/**
 * Apply access control from msg properties.
 */
function applyAccessControl(opts, msg) {
  if (msg.accessLevel !== undefined) opts.accessLevel = msg.accessLevel;
  if (msg.userAccessLevel !== undefined) opts.userAccessLevel = msg.userAccessLevel;
  if (Array.isArray(msg.permissions)) opts.rolePermissions = msg.permissions;
}

/**
 * Convert a datatype string to an OPC UA DataType enum value.
 */
function toOpcuaDataType(typeStr) {
  const map = {
    Boolean: opcua.DataType.Boolean,
    Byte: opcua.DataType.Byte,
    SByte: opcua.DataType.SByte,
    Int16: opcua.DataType.Int16,
    Int32: opcua.DataType.Int32,
    Int64: opcua.DataType.Int64,
    UInt16: opcua.DataType.UInt16,
    UInt32: opcua.DataType.UInt32,
    UInt64: opcua.DataType.UInt64,
    Float: opcua.DataType.Float,
    Double: opcua.DataType.Double,
    String: opcua.DataType.String,
    DateTime: opcua.DataType.DateTime,
    ByteString: opcua.DataType.ByteString,
    NodeId: opcua.DataType.NodeId,
    LocalizedText: opcua.DataType.LocalizedText,
    ExtensionObject: opcua.DataType.ExtensionObject,
  };
  return map[typeStr] || opcua.DataType.String;
}

/**
 * Get a default value for a data type.
 */
function getDefaultForType(datatype) {
  const defaults = {
    Boolean: false,
    Byte: 0, SByte: 0,
    Int16: 0, Int32: 0, Int64: 0,
    UInt16: 0, UInt32: 0, UInt64: 0,
    Float: 0.0, Double: 0.0,
    String: "",
    DateTime: new Date(),
    ByteString: Buffer.alloc(0),
  };
  return defaults[datatype] ?? 0;
}

/**
 * Resolve a quality string or number to an OPC UA StatusCode.
 */
function resolveStatusCode(quality) {
  if (!quality) return opcua.StatusCodes.Good;
  if (typeof quality === "number") return opcua.StatusCode.makeStatusCode(quality);
  if (typeof quality === "string" && opcua.StatusCodes[quality]) {
    return opcua.StatusCodes[quality];
  }
  return opcua.StatusCodes.Good;
}

/**
 * Check if a message is a variable update.
 */
function isVariableUpdate(msg) {
  return Array.isArray(msg.items) && msg.items.length > 0
    && msg.items.some((item) => item.value !== undefined);
}

/**
 * Derive the node name (identifier) from a full nodeId string.
 */
function deriveNodeName(nodeId) {
  if (!nodeId) return "";
  const sMatch = nodeId.match(/s=([^;]+)/);
  if (sMatch) return sMatch[1];
  const iMatch = nodeId.match(/i=(\d+)/);
  if (iMatch) return iMatch[1];
  return nodeId;
}

/**
 * Derive a storage key ("ns:name") from a full nodeId string.
 */
function deriveVariableKey(nodeId) {
  const nsMatch = nodeId.match(/ns=(\d+)/);
  const sMatch = nodeId.match(/s=([^;]+)/);
  const iMatch = nodeId.match(/i=(\d+)/);
  const ns = nsMatch ? nsMatch[1] : "1";
  const name = sMatch ? sMatch[1] : (iMatch ? iMatch[1] : nodeId);
  return `${ns}:${name}`;
}

/**
 * Resolve the namespace to use for creating a node with the given nodeId.
 * Falls back to getOwnNamespace() when no namespace index is specified.
 */
function resolveNamespace(addressSpace, nodeId) {
  if (!nodeId) return addressSpace.getOwnNamespace();
  const nsMatch = String(nodeId).match(/ns=(\d+)/);
  if (!nsMatch) return addressSpace.getOwnNamespace();
  const nsIndex = parseInt(nsMatch[1], 10);
  const nsArray = addressSpace.getNamespaceArray();
  if (nsIndex >= 0 && nsIndex < nsArray.length) return nsArray[nsIndex];
  return addressSpace.getOwnNamespace();
}
