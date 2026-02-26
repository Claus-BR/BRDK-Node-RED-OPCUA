/**
 * @file opcua-browser.js
 * @description OPC UA Browser node — browses the address space with an ephemeral connection.
 *
 * Unlike the Client node (which maintains a persistent connection), this node
 * creates a fresh connection per browse operation. This makes it ideal for
 * one-shot exploration of the address space.
 *
 * For each browsed reference, it also reads the Value and DataType attributes,
 * enriching the results.
 *
 * Output:
 *   msg.payload  — array of browse result references with value and dataType
 *   msg.endpoint — the endpoint URL
 */

"use strict";

const opcua = require("node-opcua");
const { getClientCertificateManager } = require("../lib/opcua-certificate-manager");
const { resolveUserIdentity, resolveSecurityMode, resolveSecurityPolicy } = require("../lib/opcua-connection");

module.exports = function (RED) {

  function OpcUaBrowserNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration ────────────────────────────────────────────────────
    this.endpointNode = RED.nodes.getNode(config.endpoint);
    this.topic        = config.topic || "";
    this.name         = config.name || "";

    // ── Validate endpoint ────────────────────────────────────────────────
    if (!this.endpointNode) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    node.status({ fill: "grey", shape: "ring", text: "idle" });

    // ── Input handler ────────────────────────────────────────────────────
    node.on("input", async (msg, send, done) => {
      const browseNodeId = msg.topic || node.topic || "ns=0;i=85"; // Default: Objects folder

      // Validate the NodeId
      if (browseNodeId !== "ns=0;i=85" && !opcua.isValidNodeId(browseNodeId)) {
        node.error(`Invalid NodeId: ${browseNodeId}`, msg);
        done();
        return;
      }

      let client = null;
      let session = null;

      try {
        // Initialize certificate manager
        const certManager = getClientCertificateManager();
        await certManager.initialize();

        // Create ephemeral client
        client = opcua.OPCUAClient.create({
          applicationName: "BRDK-NodeRED-OPCUA-Browser",
          clientCertificateManager: certManager,
          securityMode: resolveSecurityMode(node.endpointNode.securityMode),
          securityPolicy: resolveSecurityPolicy(node.endpointNode.securityPolicy),
          endpointMustExist: false,
          connectionStrategy: { maxRetry: 3, initialDelay: 1000, maxDelay: 5000 },
        });

        // Connect and create session
        node.status({ fill: "yellow", shape: "dot", text: "connecting" });
        await client.connect(node.endpointNode.endpoint);

        const userIdentity = resolveUserIdentity(node.endpointNode);
        session = await client.createSession(userIdentity);

        // Browse the target node
        node.status({ fill: "green", shape: "dot", text: "browsing" });
        const browseResult = await session.browse(browseNodeId);

        if (!browseResult.references || browseResult.references.length === 0) {
          node.status({ fill: "grey", shape: "dot", text: "no items" });
          msg.payload = [];
          msg.endpoint = node.endpointNode.endpoint;
          send(msg);
          done();
          await cleanup(session, client);
          return;
        }

        // Enrich each reference with Value and DataType
        const enrichedRefs = [];
        for (const ref of browseResult.references) {
          try {
            const dataValues = await session.read([
              { nodeId: ref.nodeId, attributeId: opcua.AttributeIds.Value },
              { nodeId: ref.nodeId, attributeId: opcua.AttributeIds.DataType },
            ]);

            enrichedRefs.push({
              browseName: ref.browseName.toString(),
              nodeId: ref.nodeId.toString(),
              displayName: ref.displayName?.text || "",
              nodeClass: ref.nodeClass,
              typeDefinition: ref.typeDefinition?.toString() || "",
              value: dataValues[0]?.value?.value ?? null,
              dataType: dataValues[1]?.value?.value
                ? opcua.DataType[dataValues[1].value.value] || dataValues[1].value.value.toString()
                : "",
              statusCode: dataValues[0]?.statusCode?.toString() || "",
            });
          } catch {
            // Some nodes may not support reading — include with null value
            enrichedRefs.push({
              browseName: ref.browseName.toString(),
              nodeId: ref.nodeId.toString(),
              displayName: ref.displayName?.text || "",
              nodeClass: ref.nodeClass,
              typeDefinition: ref.typeDefinition?.toString() || "",
              value: null,
              dataType: "",
              statusCode: "",
            });
          }
        }

        msg.payload = enrichedRefs;
        msg.endpoint = node.endpointNode.endpoint;

        node.status({ fill: "green", shape: "dot", text: `done: ${enrichedRefs.length} items` });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "error" });
        node.error(`Browse error: ${err.message}`, msg);
        done(err);
      } finally {
        await cleanup(session, client);
      }
    });
  }

  RED.nodes.registerType("opcua-browser", OpcUaBrowserNode);
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Gracefully close session and disconnect client.
 */
async function cleanup(session, client) {
  try {
    if (session) await session.close(true);
  } catch { /* already closed */ }
  try {
    if (client) await client.disconnect();
  } catch { /* already disconnected */ }
}
