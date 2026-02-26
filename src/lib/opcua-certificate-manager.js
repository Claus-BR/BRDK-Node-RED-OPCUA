/**
 * @file opcua-certificate-manager.js
 * @description Singleton certificate manager factory for OPC UA PKI.
 *
 * Provides lazily-initialized, OS-appropriate certificate stores for:
 *   - Client connections
 *   - User identity certificates
 *
 * Each manager is created once and reused across all nodes in the runtime.
 */

"use strict";

const { OPCUACertificateManager } = require("node-opcua");
const envPaths = require("env-paths");

const paths = envPaths("brdk-node-red-opcua");

// ── Singleton instances ────────────────────────────────────────────────────────

let clientCertificateManager = null;
let userCertificateManager = null;

// ── Factory functions ──────────────────────────────────────────────────────────

/**
 * Returns the shared client certificate manager (creates it on first call).
 * Certificates are stored in `{OS config dir}/brdk-node-red-opcua/PKI/`.
 *
 * @returns {OPCUACertificateManager}
 */
function getClientCertificateManager() {
  if (!clientCertificateManager) {
    clientCertificateManager = new OPCUACertificateManager({
      automaticallyAcceptUnknownCertificate: true,
      rootFolder: `${paths.config}/PKI`,
    });
  }
  return clientCertificateManager;
}

/**
 * Returns the shared user certificate manager (creates it on first call).
 * Certificates are stored in `{OS config dir}/brdk-node-red-opcua/UserPKI/`.
 *
 * @returns {OPCUACertificateManager}
 */
function getUserCertificateManager() {
  if (!userCertificateManager) {
    userCertificateManager = new OPCUACertificateManager({
      automaticallyAcceptUnknownCertificate: true,
      rootFolder: `${paths.config}/UserPKI`,
    });
  }
  return userCertificateManager;
}

module.exports = {
  getClientCertificateManager,
  getUserCertificateManager,
};
