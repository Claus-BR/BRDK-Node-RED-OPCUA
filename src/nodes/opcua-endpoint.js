/**
 * @file opcua-endpoint.js
 * @description OPC UA Endpoint configuration node.
 *
 * This is a Node-RED **config node** (not visible in the palette). It stores
 * the connection details for an OPC UA server and is referenced by other nodes
 * (Client, Browser, Method, etc.).
 *
 * Stores:
 *   - Server endpoint URL
 *   - Security policy & mode
 *   - Authentication method (anonymous, username/password, X.509 certificate)
 *   - Credential storage (username, password — encrypted by Node-RED)
 */

"use strict";

module.exports = function (RED) {
  /**
   * OpcUaEndpoint — Configuration node constructor.
   *
   * @param {object} config - Node configuration from the editor.
   */
  function OpcUaEndpointNode(config) {
    RED.nodes.createNode(this, config);

    // ── Connection settings ──────────────────────────────────────────────
    this.endpoint       = config.endpoint;
    this.securityPolicy = config.securityPolicy || "None";
    this.securityMode   = normalizeSecurityMode(config.securityMode);

    // ── Authentication method flags ──────────────────────────────────────
    this.none     = config.none !== false;   // Anonymous (default true)
    this.login    = config.login === true;   // Username / password
    this.usercert = config.usercert === true; // X.509 user certificate

    // ── Certificate file paths (only when usercert is true) ──────────────
    this.userCertificate = config.userCertificate || "";
    this.userPrivatekey  = config.userPrivatekey || "";

    // ── Display name ─────────────────────────────────────────────────────
    this.name = config.name || "";
  }

  RED.nodes.registerType("opcua-endpoint", OpcUaEndpointNode, {
    credentials: {
      user:     { type: "text" },
      password: { type: "password" },
    },
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Normalize legacy uppercase security mode strings to mixed-case.
 *
 * The old library used "NONE", "SIGN", "SIGNANDENCRYPT" internally.
 * node-opcua v2+ expects "None", "Sign", "SignAndEncrypt".
 *
 * @param {string} mode - The security mode string from config.
 * @returns {string} Normalized mode string.
 */
function normalizeSecurityMode(mode) {
  const map = {
    NONE:           "None",
    SIGN:           "Sign",
    SIGNANDENCRYPT: "SignAndEncrypt",
  };
  return map[String(mode).toUpperCase()] || mode || "None";
}
