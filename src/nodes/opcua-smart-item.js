/**
 * @file opcua-smart-item.js
 * @description OPC UA Smart Item node — configurable item(s) with server-side
 * address space browsing from the editor.
 *
 * Always outputs `msg.items` as an array of `{ nodeId, datatype, browseName }`
 * objects, regardless of how many items are configured (1 or N).
 *
 * The editor exposes HTTP admin endpoints so the treeview can browse
 * the OPC UA server's address space in real time.
 *
 * ─── Outputs ──────────────────────────────────────────────────────────
 *   Output 1 — Enriched message ready for the OPC UA Client node
 */

"use strict";

const opcua = require("node-opcua");
const { getClientCertificateManager } = require("../lib/opcua-certificate-manager");
const {
  resolveUserIdentity,
  resolveSecurityMode,
  resolveSecurityPolicy,
} = require("../lib/opcua-connection");
const {
  coerceScalarValue,
  isArrayType,
  coerceArrayValue,
} = require("../lib/opcua-data-converter");
const { getExtraDataTypeManager, DataTypeExtractStrategy } = require("node-opcua-client-dynamic-extension-object");

module.exports = function (RED) {

  // ═══════════════════════════════════════════════════════════════════════
  //  NODE CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════════════

  function OpcUaSmartItemNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration ──────────────────────────────────────────────────
    this.endpointNode = RED.nodes.getNode(config.endpoint);
    this.name         = config.name || "";

    // Items array: [{ nodeId, datatype, browseName }]
    this.items = [];
    try {
      this.items = JSON.parse(config.items || "[]");
    } catch {
      this.items = [];
    }

    // Method configuration: { objectId, methodId, browseName, inputArguments }
    this.method = null;
    try {
      this.method = JSON.parse(config.method || "null");
    } catch {
      this.method = null;
    }

    // ── Input handler ──────────────────────────────────────────────────
    node.on("input", (msg, send, done) => {
      if (node.items.length === 0 && !node.method) {
        node.warn("No items or method configured");
        done();
        return;
      }

      // Always output items as an array (may be empty if only a method is configured)
      if (node.items.length > 0) {
        msg.items = node.items.map((item) => {
          const itemObj = {
            nodeId:     item.nodeId,
            datatype:   item.datatype || "",
            browseName: item.browseName || "",
          };

          // Include per-item static value if configured (for write operations)
          if (item.value !== undefined && item.value !== null && item.value !== "") {
            itemObj.value = coerceValue(item.datatype || "", item.value);
          }

          return itemObj;
        });

        // Set topic to first item's nodeId for convenience / debug display
        msg.topic = node.items[0].nodeId;
      }

      // Method configuration
      if (node.method) {
        msg.objectId = msg.objectId || node.method.objectId;
        msg.methodId = msg.methodId || node.method.methodId;

        if (!msg.inputArguments && Array.isArray(node.method.inputArguments)) {
          const args = node.method.inputArguments
            .filter((a) => a.dataType)
            .map((a) => {
              const entry = {
                dataType: a.isExtensionObject ? "ExtensionObject" : a.dataType,
                value:    a.value ?? "",
              };
              // For ExtensionObjects, pass the type NodeId so the client
              // can call session.constructExtensionObject()
              if (a.isExtensionObject && a.dataTypeNodeId) {
                entry.typeid = a.dataTypeNodeId;
              }
              return entry;
            });
          if (args.length > 0) {
            msg.inputArguments = args;
          }
        }
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType("opcua-smart-item", OpcUaSmartItemNode);

  // ═══════════════════════════════════════════════════════════════════════
  //  HTTP ADMIN ENDPOINTS — Editor address space browsing
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /opcua-smart-item/browse
   *
   * Query params:
   *   - endpointId   — ID of the opcua-endpoint config node
   *   - nodeId       — NodeId to browse (default: "ns=0;i=84" = RootFolder)
   *
   * Returns JSON object with `children` array (browseName, nodeId, displayName,
   * nodeClass, dataType, hasChildren) and `serverName` from the OPC UA server.
   * 
   * Sorts folders first, then alphabetically — similar to UaExpert.
   */
  RED.httpAdmin.get("/opcua-smart-item/browse", async (req, res) => {
    const endpointId = req.query.endpointId;
    const nodeId     = req.query.nodeId || "ns=0;i=84";

    if (!endpointId) {
      return res.status(400).json({ error: "endpointId is required" });
    }

    const endpointNode = RED.nodes.getNode(endpointId);
    if (!endpointNode) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy first." });
    }

    let client = null;
    let session = null;

    try {
      // Initialize certificate manager
      const certManager = getClientCertificateManager();
      await certManager.initialize();

      // Create ephemeral client
      client = opcua.OPCUAClient.create({
        applicationName: "BRDK-NodeRED-SmartItem-Browser",
        clientCertificateManager: certManager,
        securityMode: resolveSecurityMode(endpointNode.securityMode),
        securityPolicy: resolveSecurityPolicy(endpointNode.securityPolicy),
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 2, initialDelay: 500, maxDelay: 3000 },
        requestedSessionTimeout: 30000,
      });

      await client.connect(endpointNode.endpoint);
      const userIdentity = resolveUserIdentity(endpointNode);
      session = await client.createSession(userIdentity);

      // Read the server's ApplicationName from its endpoints
      let serverName = "";
      try {
        const endpoints = await client.getEndpoints();
        if (endpoints && endpoints.length > 0) {
          const appName = endpoints[0].server?.applicationName;
          serverName = (appName && appName.text) ? appName.text : "";
        }
      } catch {
        // Fall back to empty — not critical
      }

      // Browse the requested node — only follow Hierarchical references
      // (excludes HasTypeDefinition, HasModellingRule, GeneratesEvent etc.)
      const browseResult = await session.browse({
        nodeId,
        browseDirection: opcua.BrowseDirection.Forward,
        referenceTypeId: "HierarchicalReferences",
        includeSubtypes: true,
        resultMask: 0x3F, // All fields
      });


      // BrowseNames to filter out (irrelevant meta/type-definition nodes)
      const FILTERED_BROWSE_NAMES = new Set([
        "FolderType", "BaseObjectType", "BaseVariableType",
        "BaseDataVariableType", "PropertyType", "ModellingRules",
        "AggregateFunctions",
      ]);

      const children = [];

      if (browseResult.references) {
        for (const ref of browseResult.references) {
          const refNodeId = ref.nodeId.toString();
          const browseName = ref.browseName?.name || ref.browseName?.toString() || "";

          // Skip irrelevant meta nodes
          if (FILTERED_BROWSE_NAMES.has(browseName)) continue;

          let dataType = "";
          let isArray = false;

          // Read DataType and ValueRank for Variable nodes
          if (ref.nodeClass === opcua.NodeClass.Variable) {
            try {
              const dtResult = await session.read({
                nodeId: ref.nodeId,
                attributeId: opcua.AttributeIds.DataType,
              });
              if (dtResult.value?.value) {
                const dtNodeId = dtResult.value.value;
                const dtNode = await session.read({
                  nodeId: dtNodeId,
                  attributeId: opcua.AttributeIds.BrowseName,
                });
                dataType = dtNode.value?.value?.name || opcua.DataType[dtNodeId.value] || dtNodeId.toString();
              }
            } catch {
              // Ignore read errors
            }

            try {
              const vrResult = await session.read({
                nodeId: ref.nodeId,
                attributeId: opcua.AttributeIds.ValueRank,
              });
              const valueRank = vrResult.value?.value;
              if (valueRank !== undefined && valueRank !== null && valueRank >= 0) {
                isArray = true;
              }
            } catch {
              // Ignore read errors
            }
          }

          // Check if node has children (for tree expansion)
          let hasChildren = ref.nodeClass === opcua.NodeClass.Object
            || ref.nodeClass === opcua.NodeClass.View;

          if (!hasChildren) {
            try {
              const childBrowse = await session.browse({
                nodeId: ref.nodeId,
                browseDirection: opcua.BrowseDirection.Forward,
                resultMask: 0x01, // Minimal — just need count
              });
              hasChildren = (childBrowse.references?.length || 0) > 0;
            } catch {
              // Assume no children on error
            }
          }

          children.push({
            browseName,
            nodeId:      refNodeId,
            displayName: ref.displayName?.text || "",
            nodeClass:   opcua.NodeClass[ref.nodeClass] || String(ref.nodeClass),
            dataType,
            hasChildren,
            isVariable:  ref.nodeClass === opcua.NodeClass.Variable,
            isMethod:    ref.nodeClass === opcua.NodeClass.Method,
            isArray,
          });
        }
      }

      // Sort: Folders/Objects first, then Methods, then Variables, alphabetically within each group
      children.sort((a, b) => {
        // Assign sort priority: Objects/Folders=0, Methods=1, Variables=2
        const priority = (c) => c.isVariable ? 2 : c.isMethod ? 1 : 0;
        const pa = priority(a);
        const pb = priority(b);
        if (pa !== pb) return pa - pb;
        // Alphabetical by displayName or browseName
        const nameA = (a.displayName || a.browseName).toLowerCase();
        const nameB = (b.displayName || b.browseName).toLowerCase();
        return nameA.localeCompare(nameB);
      });

      res.json({ children, serverName, _debug: { refCount: browseResult.references?.length || 0, childCount: children.length } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try {
        if (session) await session.close();
        if (client) await client.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  HTTP ADMIN ENDPOINT — Method InputArguments
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /opcua-smart-item/method-args
   *
   * Query params:
   *   - endpointId — ID of the opcua-endpoint config node
   *   - methodId   — NodeId of the method
   *
   * Returns JSON with `inputArguments` array of { name, dataType, description, valueRank }.
   */
  RED.httpAdmin.get("/opcua-smart-item/method-args", async (req, res) => {
    const endpointId = req.query.endpointId;
    const methodId   = req.query.methodId;

    if (!endpointId || !methodId) {
      return res.status(400).json({ error: "endpointId and methodId are required" });
    }

    const endpointNode = RED.nodes.getNode(endpointId);
    if (!endpointNode) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy first." });
    }

    let client = null;
    let session = null;

    try {
      const certManager = getClientCertificateManager();
      await certManager.initialize();

      client = opcua.OPCUAClient.create({
        applicationName: "BRDK-NodeRED-SmartItem-MethodArgs",
        clientCertificateManager: certManager,
        securityMode: resolveSecurityMode(endpointNode.securityMode),
        securityPolicy: resolveSecurityPolicy(endpointNode.securityPolicy),
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 2, initialDelay: 500, maxDelay: 3000 },
        requestedSessionTimeout: 30000,
      });

      await client.connect(endpointNode.endpoint);
      const userIdentity = resolveUserIdentity(endpointNode);
      session = await client.createSession(userIdentity);

      // Browse the method for its InputArguments property
      const browseResult = await session.browse({
        nodeId: methodId,
        browseDirection: opcua.BrowseDirection.Forward,
        referenceTypeId: "HasProperty",
        includeSubtypes: true,
        resultMask: 0x3F,
      });

      const inputArguments = [];

      if (browseResult.references) {
        for (const ref of browseResult.references) {
          const name = ref.browseName?.name || "";
          if (name === "InputArguments") {
            // Read the InputArguments value
            const readResult = await session.read({
              nodeId: ref.nodeId,
              attributeId: opcua.AttributeIds.Value,
            });

            const args = readResult.value?.value;
            if (Array.isArray(args)) {
              for (const arg of args) {
                // Resolve DataType NodeId to human-readable name
                let dtName = "";
                if (arg.dataType) {
                  try {
                    const dtBrowse = await session.read({
                      nodeId: arg.dataType,
                      attributeId: opcua.AttributeIds.BrowseName,
                    });
                    dtName = dtBrowse.value?.value?.name || opcua.DataType[arg.dataType.value] || arg.dataType.toString();
                  } catch {
                    dtName = arg.dataType.toString();
                  }
                }

                inputArguments.push({
                  name:           arg.name || "",
                  dataType:       dtName,
                  dataTypeNodeId: arg.dataType ? arg.dataType.toString() : "",
                  description:    arg.description?.text || "",
                  valueRank:      arg.valueRank ?? -1,
                });
              }
            }
            break;
          }
        }
      }

      res.json({ inputArguments });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try {
        if (session) await session.close();
        if (client) await client.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  HTTP ADMIN ENDPOINT — ExtensionObject Type Fields
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /opcua-smart-item/type-fields
   *
   * Query params:
   *   - endpointId     — ID of the opcua-endpoint config node
   *   - dataTypeNodeId — NodeId of the structured data type
   *
   * Constructs an empty ExtensionObject and returns its fields.
   */
  RED.httpAdmin.get("/opcua-smart-item/type-fields", async (req, res) => {
    const endpointId     = req.query.endpointId;
    const dataTypeNodeId = req.query.dataTypeNodeId;

    if (!endpointId || !dataTypeNodeId) {
      return res.status(400).json({ error: "endpointId and dataTypeNodeId are required" });
    }

    const endpointNode = RED.nodes.getNode(endpointId);
    if (!endpointNode) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy first." });
    }

    let client = null;
    let session = null;

    try {
      const certManager = getClientCertificateManager();
      await certManager.initialize();

      client = opcua.OPCUAClient.create({
        applicationName: "BRDK-NodeRED-SmartItem-TypeFields",
        clientCertificateManager: certManager,
        securityMode: resolveSecurityMode(endpointNode.securityMode),
        securityPolicy: resolveSecurityPolicy(endpointNode.securityPolicy),
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 2, initialDelay: 500, maxDelay: 3000 },
        requestedSessionTimeout: 30000,
      });

      await client.connect(endpointNode.endpoint);
      const userIdentity = resolveUserIdentity(endpointNode);
      session = await client.createSession(userIdentity);

      // Load custom DataType dictionaries so vendor types are known
      await getExtraDataTypeManager(session, DataTypeExtractStrategy.Both);

      // Construct an empty ExtensionObject to discover its fields
      const extObj = await session.constructExtensionObject(
        opcua.coerceNodeId(dataTypeNodeId),
        {},
      );

      // Extract fields from the constructed object
      const fields = [];
      if (extObj && typeof extObj === "object") {
        for (const [key, val] of Object.entries(extObj)) {
          // Skip internal/schema properties
          if (key.startsWith("_") || key === "schema" || key === "encodingDefaultBinary" || key === "encodingDefaultXml") continue;

          let fieldType = "String";
          let defaultVal = "";
          if (typeof val === "number") {
            fieldType = "Double";
            defaultVal = String(val);
          } else if (typeof val === "boolean") {
            fieldType = "Boolean";
            defaultVal = String(val);
          } else if (val instanceof Date) {
            fieldType = "DateTime";
            defaultVal = val.toISOString();
          } else if (val && val.constructor?.name === "NodeId") {
            fieldType = "NodeId";
            defaultVal = val.toString();
          } else if (typeof val === "string") {
            fieldType = "String";
            defaultVal = val;
          } else if (val && typeof val === "object" && typeof val.value === "number") {
            // Enum types (e.g. ServerState) have a numeric .value
            fieldType = val.constructor?.name || "Enum";
            defaultVal = String(val.value);
          } else if (val && typeof val === "object") {
            fieldType = val.constructor?.name || "Object";
            defaultVal = "";
          }

          fields.push({
            name: key,
            dataType: fieldType,
            defaultValue: defaultVal,
          });
        }
      }

      res.json({ fields });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try {
        if (session) await session.close();
        if (client) await client.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Coerce a value using the appropriate scalar or array converter.
 */
function coerceValue(datatype, value) {
  if (!datatype) return value;
  if (isArrayType(datatype)) return coerceArrayValue(datatype, value);
  return coerceScalarValue(datatype, value);
}
