/**
 * @file opcua-server.js
 * @description OPC UA Server node — creates and manages an OPC UA server.
 *
 * Supports dynamic address space management via input messages:
 *
 *   VARIABLES:    addVariable, deleteNode, (and messageType=Variable for value updates)
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
 * ─── Outputs ───────────────────────────────────────────────────────────────────
 *   Output 1 — Session events, variable changes by clients, command results
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
    this.port           = Number(process.env.SERVER_PORT || config.port) || 53880;
    this.name           = config.name || "";
    this.resourcePath   = config.endpoint || "";
    this.usersFile      = config.users || "";
    this.nodesetDir     = config.nodesetDir || "";

    // Security options
    this.autoAcceptUnknownCertificate = config.autoAcceptUnknownCertificate !== false;
    this.registerToDiscovery          = config.registerToDiscovery === true;
    this.constructDefaultAddressSpace = config.constructDefaultAddressSpace !== false;
    this.allowAnonymous               = config.allowAnonymous !== false;

    // Security modes
    this.endpointNone          = config.endpointNone !== false;
    this.endpointSign          = config.endpointSign !== false;
    this.endpointSignEncrypt   = config.endpointSignEncrypt !== false;

    // Security policies
    this.endpointBasic128Rsa15   = config.endpointBasic128Rsa15 !== false;
    this.endpointBasic256        = config.endpointBasic256 !== false;
    this.endpointBasic256Sha256  = config.endpointBasic256Sha256 !== false;

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
        const command = msg.payload?.opcuaCommand;

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

        // Collect nodeset XML files
        const nodesetFiles = collectNodesetFiles(node);

        // Build server options
        const hostname = os.hostname();
        const serverOptions = {
          port: node.port,
          resourcePath: node.resourcePath ? `/${node.resourcePath}` : undefined,
          nodeset_filename: nodesetFiles,
          serverCertificateManager: serverCertManager,
          userCertificateManager: userCertManager,
          allowAnonymous: node.allowAnonymous,
          securityModes,
          securityPolicies,
          maxConnectionsPerEndpoint: node.maxConnectionsPerEndpoint,
          maxSessions: node.maxSessions,
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

        // Install alarm/condition and aggregate support
        try {
          const addressSpace = node.server.engine.addressSpace;
          opcua.installAlarmMonitoring(addressSpace);
          opcua.addAggregateSupport(addressSpace);
        } catch {
          // Not critical if these fail
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
    //  VARIABLE UPDATES (messageType: "Variable")
    // ═══════════════════════════════════════════════════════════════════

    function handleVariableUpdates(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const items = Array.isArray(msg.payload) ? msg.payload : [msg.payload];

      for (const item of items) {
        if (item.messageType !== "Variable") continue;

        const { namespace, variableName, variableValue, datatype, quality, sourceTimestamp } = item;
        const key = `${namespace}:${variableName}`;
        const nodeId = typeof variableName === "number"
          ? `ns=${namespace};i=${variableName}`
          : `ns=${namespace};s=${variableName}`;

        const vnode = addressSpace.findNode(nodeId);
        if (!vnode) {
          node.warn(`Variable not found: ${nodeId}`);
          continue;
        }

        node.variables[key] = variableValue;

        if (quality || sourceTimestamp) {
          // Write with quality/timestamp via PseudoSession
          const statusCode = resolveStatusCode(quality);
          const ts = sourceTimestamp ? new Date(sourceTimestamp) : new Date();
          node.variablesTs[key] = ts;
          node.variablesStatus[key] = statusCode;

          try {
            const session = new opcua.PseudoSession(addressSpace);
            const dataValue = converter.buildDataValue(
              datatype || "Double",
              variableValue,
              ts,
              statusCode,
            );

            session.write({
              nodeId: opcua.coerceNodeId(nodeId),
              attributeId: opcua.AttributeIds.Value,
              value: dataValue,
            });
          } catch (err) {
            node.warn(`PseudoSession write error: ${err.message}`);
          }
        } else {
          // Simple value update
          const builtValue = converter.buildDataValue(datatype || "Double", variableValue);
          vnode.setValueFromSource(builtValue);
        }
      }

      done();
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
     * Add a variable to the address space.
     *
     * msg.topic format: ns=X;s=Name;datatype=Type[;value=V][;description=D][;browseName=BN][;displayName=DN]
     */
    function cmdAddVariable(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      if (!parsed.nodeId || !parsed.datatype) {
        node.warn("addVariable requires msg.topic with nodeId and datatype");
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
        const varOpts = buildVariableOptions(addressSpace, parsed, msg);
        varOpts.componentOf = parentFolder;

        const newVar = addressSpace.addVariable(varOpts);

        // Store initial value
        const ns = parsed.namespace || "1";
        const key = `${ns}:${parsed.name}`;
        node.variables[key] = parsed.value || getDefaultForType(parsed.datatype);

        // Bind get/set callbacks
        bindVariableGetSet(newVar, key, parsed.datatype, send);

        msg.payload = {
          messageType: "Variable",
          variableName: parsed.name,
          nodeId: newVar.nodeId.toString(),
        };
        send(msg);
        done();
      } catch (err) {
        node.error(`addVariable failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add a folder to the address space.
     */
    function cmdAddFolder(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      const parentFolder = node.currentFolder || node.vendorName;
      if (!parentFolder) {
        node.warn("No parent folder set");
        done();
        return;
      }

      try {
        const folderOpts = {
          organizedBy: parentFolder,
          browseName: parsed.browseName || parsed.name,
          displayName: parsed.displayName || parsed.name,
          nodeId: parsed.nodeId,
        };

        if (parsed.description) {
          folderOpts.description = parsed.description;
        }

        // Apply access control from msg
        applyAccessControl(folderOpts, msg);

        addressSpace.addFolder(parentFolder, folderOpts);
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
      const nodeId = msg.topic;

      if (!nodeId) {
        node.warn("setFolder requires msg.topic with a nodeId");
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
     * Delete a node from the address space.
     */
    function cmdDeleteNode(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const nodeId = msg.payload?.nodeId;

      if (!nodeId) {
        node.warn("deleteNode requires msg.payload.nodeId");
        done();
        return;
      }

      try {
        const nodeToDelete = addressSpace.findNode(nodeId);
        if (nodeToDelete) {
          addressSpace.deleteNode(nodeToDelete);
        } else {
          node.warn(`Node not found for deletion: ${nodeId}`);
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
      const name = msg.payload?.nodeName;

      if (!name || !node.vendorName) {
        node.warn("addEquipment requires msg.payload.nodeName and a default address space");
        done();
        return;
      }

      try {
        addressSpace.addObject({
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
      const name = msg.payload?.nodeName;

      if (!name || !node.vendorName) {
        node.warn("addPhysicalAsset requires msg.payload.nodeName");
        done();
        return;
      }

      try {
        addressSpace.addObject({
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
      const parentNodeId = msg.topic;
      const methodName = msg.browseName;
      const inputArgs = msg.inputArguments || [];
      const outputArgs = msg.outputArguments || [];

      if (!parentNodeId || !methodName) {
        node.warn("addMethod requires msg.topic (parent) and msg.browseName");
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

        const method = addressSpace.addMethod(parentNode, {
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
      const methodNodeId = msg.topic;
      const methodFunc = msg.code;

      if (!methodNodeId || !methodFunc) {
        node.warn("bindMethod requires msg.topic (method nodeId) and msg.code (function)");
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
     * Install historian on a variable.
     */
    function cmdInstallHistorian(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      if (!parsed.nodeId) {
        node.warn("installHistorian requires msg.topic with nodeId");
        done();
        return;
      }

      try {
        const variable = addressSpace.findNode(parsed.nodeId);
        if (!variable) {
          node.warn(`Variable not found for historian: ${parsed.nodeId}`);
          done();
          return;
        }

        addressSpace.installHistoricalDataNode(variable, {
          maxOnlineValues: 1000,
        });
        done();
      } catch (err) {
        node.error(`installHistorian failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Install a discrete (boolean) alarm on a variable.
     */
    function cmdInstallDiscreteAlarm(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      if (!parsed.nodeId) {
        node.warn("installDiscreteAlarm requires msg.topic with nodeId");
        done();
        return;
      }

      try {
        const parentNode = addressSpace.findNode(parsed.nodeId);
        if (!parentNode) {
          node.warn(`Node not found: ${parsed.nodeId}`);
          done();
          return;
        }

        const severity = msg.priority || 100;
        const alarmText = msg.alarmText || `Alarm on ${parsed.name}`;

        // Create a Boolean "AlarmState" variable
        const alarmStateVar = addressSpace.addVariable({
          propertyOf: parentNode,
          browseName: `${parsed.name}AlarmState`,
          dataType: "Boolean",
          value: { dataType: opcua.DataType.Boolean, value: false },
        });

        // Create the DiscreteAlarm
        const alarm = addressSpace.instantiateDiscreteAlarm("DiscreteAlarmType", {
          componentOf: parentNode,
          browseName: `${parsed.name}DiscreteAlarm`,
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

        done();
      } catch (err) {
        node.error(`installDiscreteAlarm failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Install a non-exclusive limit alarm (HH/H/L/LL) on a variable.
     */
    function cmdInstallLimitAlarm(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      if (!parsed.nodeId) {
        node.warn("installLimitAlarm requires msg.topic with nodeId");
        done();
        return;
      }

      try {
        const parentNode = addressSpace.findNode(parsed.nodeId);
        if (!parentNode) {
          node.warn(`Node not found: ${parsed.nodeId}`);
          done();
          return;
        }

        const severity = msg.priority || 100;
        const alarmText = msg.alarmText || `Limit alarm on ${parsed.name}`;
        const hh = msg.hh ?? 90;
        const h  = msg.h  ?? 70;
        const l  = msg.l  ?? 30;
        const ll = msg.ll ?? 10;

        // Create a Double "LimitState" variable
        let currentLimitValue = 0;
        const limitStateVar = addressSpace.addVariable({
          propertyOf: parentNode,
          browseName: `${parsed.name}LimitState`,
          dataType: "Double",
          value: {
            get: () => new opcua.Variant({ dataType: opcua.DataType.Double, value: currentLimitValue }),
            set: (v) => { currentLimitValue = v.value; return opcua.StatusCodes.Good; },
          },
        });

        // Create the NonExclusiveLimitAlarm
        const alarm = addressSpace.instantiateNonExclusiveLimitAlarm("NonExclusiveLimitAlarmType", {
          componentOf: parentNode,
          browseName: `${parsed.name}LimitAlarm`,
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

        done();
      } catch (err) {
        node.error(`installLimitAlarm failed: ${err.message}`, msg);
        done(err);
      }
    }

    /**
     * Add an extension object variable.
     */
    function cmdAddExtensionObject(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);

      if (!parsed.nodeId || !parsed.datatype) {
        node.warn("addExtensionObject requires msg.topic with nodeId and datatype (TypeId)");
        done();
        return;
      }

      try {
        const parentFolder = node.currentFolder || node.vendorName;
        const typeId = opcua.coerceNodeId(parsed.datatype);
        const extObj = addressSpace.constructExtensionObject(typeId, {});

        addressSpace.addVariable({
          componentOf: parentFolder,
          browseName: parsed.browseName || parsed.name,
          displayName: parsed.displayName || parsed.name,
          nodeId: parsed.nodeId,
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
     */
    function cmdAddFile(msg, send, done) {
      const addressSpace = node.server.engine.addressSpace;
      const parsed = parseTopicString(msg.topic);
      const fileName = msg.payload?.fileName;

      if (!parsed.nodeId || !fileName) {
        node.warn("addFile requires msg.topic (nodeId) and msg.payload.fileName");
        done();
        return;
      }

      try {
        const parentFolder = node.currentFolder || node.vendorName;

        installFileType(addressSpace, {
          organizedBy: parentFolder,
          browseName: parsed.name || fileName,
          nodeId: parsed.nodeId,
          fileOptions: {
            filename: fileName,
            mimeType: "application/octet-stream",
          },
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
      const namespaceUri = msg.topic;

      if (!namespaceUri) {
        node.warn("registerNamespace requires msg.topic with namespace URI");
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
      const namespaceUri = msg.topic;

      if (!namespaceUri) {
        node.warn("getNamespaceIndex requires msg.topic with namespace URI");
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
      const newUsers = msg.payload?.users;

      if (!Array.isArray(newUsers)) {
        node.warn("setUsers requires msg.payload.users as an array");
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
      const nsIndex = msg.topic ? parseInt(msg.topic, 10) : 1;
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
            payload: {
              messageType: "Variable",
              variableName: key,
              variableValue: newValue,
            },
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
  const xmlDir = path.join(__dirname, "..", "public", "vendor", "opc-foundation", "xml");
  const files = [path.join(xmlDir, "Opc.Ua.NodeSet2.xml")];

  // Standard nodesets
  const standardNodesets = [
    "Opc.Ua.Di.NodeSet2.xml",
    "Opc.Ua.AutoID.NodeSet2.xml",
    "Opc.ISA95.NodeSet2.xml",
  ];

  for (const ns of standardNodesets) {
    const nsPath = path.join(xmlDir, ns);
    if (fs.existsSync(nsPath)) files.push(nsPath);
  }

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
 * Parse a topic string like "ns=1;s=MyVar;datatype=Double;value=42;description=Test;browseName=BN;displayName=DN"
 */
function parseTopicString(topic) {
  if (!topic) return {};

  const result = { nodeId: "", name: "", namespace: "1", datatype: "", value: null };

  // Extract key=value pairs separated by semicolons
  const parts = topic.split(";");
  const nodeIdParts = [];

  for (const part of parts) {
    const trimmed = part.trim();

    if (trimmed.startsWith("ns=")) {
      result.namespace = trimmed.substring(3);
      nodeIdParts.push(trimmed);
    } else if (trimmed.startsWith("s=")) {
      result.name = trimmed.substring(2);
      nodeIdParts.push(trimmed);
    } else if (trimmed.startsWith("i=")) {
      result.name = trimmed.substring(2);
      nodeIdParts.push(trimmed);
    } else if (trimmed.startsWith("datatype=")) {
      result.datatype = trimmed.substring(9);
    } else if (trimmed.startsWith("value=")) {
      result.value = trimmed.substring(6);
    } else if (trimmed.startsWith("description=")) {
      result.description = trimmed.substring(12);
    } else if (trimmed.startsWith("browseName=")) {
      result.browseName = trimmed.substring(11);
    } else if (trimmed.startsWith("displayName=")) {
      result.displayName = trimmed.substring(12);
    } else {
      nodeIdParts.push(trimmed);
    }
  }

  result.nodeId = nodeIdParts.join(";");
  return result;
}

/**
 * Build variable options for addVariable.
 */
function buildVariableOptions(addressSpace, parsed, msg) {
  const datatype = parsed.datatype;
  const isArray = datatype.includes("Array");
  const baseType = datatype.replace("Array", "").replace(/\[.*\]/, "");

  const opts = {
    browseName: parsed.browseName || parsed.name,
    displayName: parsed.displayName || parsed.name,
    nodeId: parsed.nodeId,
    dataType: baseType,
    accessLevel: opcua.makeAccessLevelFlag("CurrentRead | CurrentWrite"),
    userAccessLevel: opcua.makeAccessLevelFlag("CurrentRead | CurrentWrite"),
    rolePermissions: [
      { roleId: opcua.WellKnownRoles.Anonymous, permissions: opcua.allPermissions },
      { roleId: opcua.WellKnownRoles.AuthenticatedUser, permissions: opcua.allPermissions },
    ],
    accessRestrictions: opcua.AccessRestrictionsFlag.None,
  };

  if (parsed.description) {
    opts.description = parsed.description;
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
  if (!msg.payload) return false;
  if (Array.isArray(msg.payload)) {
    return msg.payload.some((item) => item.messageType === "Variable");
  }
  return msg.payload.messageType === "Variable";
}
