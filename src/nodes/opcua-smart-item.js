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

    // ── Input handler ──────────────────────────────────────────────────
    node.on("input", (msg, send, done) => {
      if (node.items.length === 0) {
        node.warn("No items configured");
        done();
        return;
      }

      // Always output items as an array
      msg.items = node.items.map((item) => {
        const itemObj = {
          nodeId:     item.nodeId,
          datatype:   item.datatype || "",
          browseName: item.browseName || "",
        };

        // For single-item write operations, coerce msg.payload into the item value
        if (node.items.length === 1 && msg.payload !== undefined && msg.payload !== null && msg.payload !== "") {
          itemObj.value = coerceValue(item.datatype || "", msg.payload);
        }

        return itemObj;
      });

      // Set topic to first item's nodeId for convenience / debug display
      msg.topic = node.items[0].nodeId;

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

          // Read DataType attribute for Variable nodes
          if (ref.nodeClass === opcua.NodeClass.Variable) {
            try {
              const dtResult = await session.read({
                nodeId: ref.nodeId,
                attributeId: opcua.AttributeIds.DataType,
              });
              if (dtResult.value?.value) {
                // Resolve the DataType NodeId to a human-readable name
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
          });
        }
      }

      // Sort: Folders/Objects first, then Variables, alphabetically within each group
      children.sort((a, b) => {
        // Variables last
        if (a.isVariable !== b.isVariable) return a.isVariable ? 1 : -1;
        // Alphabetical by displayName or browseName
        const nameA = (a.displayName || a.browseName).toLowerCase();
        const nameB = (b.displayName || b.browseName).toLowerCase();
        return nameA.localeCompare(nameB);
      });

      res.json({ children, serverName });
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
