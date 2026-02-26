/**
 * @file opcua-discovery.js
 * @description OPC UA Discovery node — starts a local LDS (Local Discovery Server)
 * on port 4840 and responds with registered server URLs on input.
 *
 * The discovery server starts automatically when the node is deployed.
 * Send any message to trigger a `findServers()` call and receive the list
 * of registered server discovery URLs.
 *
 * Output:
 *   msg.payload — array of discovery URL strings for all registered servers
 */

"use strict";

const opcua = require("node-opcua");
const os = require("os");
const path = require("path");

module.exports = function (RED) {

  function OpcUaDiscoveryNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    this.name = config.name || "";

    let server = null;

    // ── Certificate manager for discovery server ─────────────────────────
    const certManager = new opcua.OPCUACertificateManager({
      rootFolder: path.join(path.dirname(__dirname), "discovery-pki"),
      automaticallyAcceptUnknownCertificate: true,
    });

    // ── Server options ───────────────────────────────────────────────────
    const hostname = os.hostname();
    const serverOptions = {
      port: 4840,
      serverCertificateManager: certManager,
      serverInfo: {
        applicationUri: opcua.makeApplicationUrn(hostname, "BRDK-NodeRED-OPCUA-Discovery"),
        productUri: "BRDK-NodeRED-OPCUA-Discovery",
        applicationName: { text: "BRDK Node-RED OPCUA Discovery", locale: "en" },
        gatewayServerUri: null,
        discoveryProfileUri: null,
        discoveryUrls: [],
      },
      serverCapabilities: {
        maxBrowseContinuationPoints: 10,
        maxHistoryContinuationPoints: 10,
        maxSessions: 20,
      },
      buildInfo: {
        buildNumber: "1.0.0",
        buildDate: new Date().toISOString(),
      },
    };

    // ── Start the discovery server ───────────────────────────────────────
    (async () => {
      try {
        node.status({ fill: "yellow", shape: "dot", text: "starting" });
        await certManager.initialize();

        server = new opcua.OPCUADiscoveryServer(serverOptions);
        await server.start();

        const port = server.endpoints?.[0]?.port || 4840;
        node.status({ fill: "green", shape: "dot", text: `discovery on port ${port}` });
        node.log(`Discovery server listening on port ${port}`);
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "start error" });
        node.error(`Discovery server failed to start: ${err.message}`);
        node.error("Check if port 4840 is already in use (netstat -ano | findstr :4840)");
      }
    })();

    // ── Input handler — findServers ──────────────────────────────────────
    node.on("input", async (msg, send, done) => {
      const discoveryUrl = msg.discoveryUrl || "opc.tcp://localhost:4840";

      try {
        const { servers } = await opcua.findServers(discoveryUrl);
        const allUrls = [];

        for (const srv of servers) {
          for (const url of srv.discoveryUrls || []) {
            allUrls.push(url);
          }
        }

        msg.payload = allUrls;
        send(msg);
        done();
      } catch (err) {
        node.error(`findServers failed: ${err.message}`, msg);
        done(err);
      }
    });

    // ── Close handler ────────────────────────────────────────────────────
    node.on("close", async (done) => {
      if (server) {
        try {
          await server.shutdown();
          node.log("Discovery server shut down");
        } catch (err) {
          node.warn(`Discovery shutdown error: ${err.message}`);
        }
        server = null;
      }
      done();
    });
  }

  RED.nodes.registerType("opcua-discovery", OpcUaDiscoveryNode);
};
