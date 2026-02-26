/**
 * @file opcua-connection.js
 * @description Shared OPC UA connection management for Node-RED nodes.
 *
 * Encapsulates the lifecycle of an OPCUAClient:
 *   create → connect → createSession → (use) → closeSession → disconnect
 *
 * Provides:
 *   - A reusable `OpcuaClientConnection` class with event-driven state management
 *   - Automatic reconnection with command queuing
 *   - Clean session and subscription lifecycle
 *   - User identity resolution (anonymous, username/password, certificate)
 *
 * This module is used by the Client, Method, and other nodes that need a
 * persistent connection to an OPC UA server.
 */

"use strict";

const opcua = require("node-opcua");
const { readFileSync } = require("fs");
const { getClientCertificateManager } = require("./opcua-certificate-manager");

// ── Default connection strategy ────────────────────────────────────────────────

const DEFAULT_CONNECTION_STRATEGY = {
  maxRetry: 10512000,   // Effectively infinite (10 million retries ≈ years)
  initialDelay: 5000,   // 5 seconds before first retry
  maxDelay: 30_000,     // 30 seconds max between retries
};

// ── User identity resolution ───────────────────────────────────────────────────

/**
 * Build a user identity token from an endpoint configuration node.
 *
 * @param {object} endpointNode - The OpcUa-Endpoint config node instance.
 * @returns {object} A `UserIdentityInfo` object for `client.createSession()`.
 */
function resolveUserIdentity(endpointNode) {
  if (!endpointNode) {
    return { type: opcua.UserTokenType.Anonymous };
  }

  // Username / password login
  if (endpointNode.login) {
    const user = endpointNode.credentials?.user || null;
    const password = endpointNode.credentials?.password || null;
    return {
      type: opcua.UserTokenType.UserName,
      userName: user,
      password,
    };
  }

  // X.509 user certificate
  if (endpointNode.usercert) {
    try {
      const certPath = endpointNode.userCertificate;
      const keyPath = endpointNode.userPrivatekey;
      return {
        type: opcua.UserTokenType.Certificate,
        certificateData: readFileSync(certPath),
        privateKey: readFileSync(keyPath, "utf-8"),
      };
    } catch (err) {
      // Fall back to anonymous if certificate files can't be read
      return { type: opcua.UserTokenType.Anonymous };
    }
  }

  // Default: anonymous
  return { type: opcua.UserTokenType.Anonymous };
}

// ── Security mode/policy resolution ────────────────────────────────────────────

/**
 * Convert a security mode string to the corresponding `opcua.MessageSecurityMode`.
 *
 * @param {string} mode - "None", "Sign", or "SignAndEncrypt".
 * @returns {opcua.MessageSecurityMode}
 */
function resolveSecurityMode(mode) {
  const map = {
    None:            opcua.MessageSecurityMode.None,
    Sign:            opcua.MessageSecurityMode.Sign,
    SignAndEncrypt:   opcua.MessageSecurityMode.SignAndEncrypt,
    // Legacy uppercase compatibility
    NONE:            opcua.MessageSecurityMode.None,
    SIGN:            opcua.MessageSecurityMode.Sign,
    SIGNANDENCRYPT:  opcua.MessageSecurityMode.SignAndEncrypt,
  };
  return map[mode] || opcua.MessageSecurityMode.None;
}

/**
 * Convert a security policy string to the corresponding `opcua.SecurityPolicy`.
 *
 * @param {string} policy - Policy name (e.g. "Basic256Sha256").
 * @returns {opcua.SecurityPolicy}
 */
function resolveSecurityPolicy(policy) {
  const map = {
    None:                      opcua.SecurityPolicy.None,
    Basic128:                  opcua.SecurityPolicy.Basic128,
    Basic192:                  opcua.SecurityPolicy.Basic192,
    Basic192Rsa15:             opcua.SecurityPolicy.Basic192Rsa15,
    Basic256Rsa15:             opcua.SecurityPolicy.Basic256Rsa15,
    Basic256Sha256:            opcua.SecurityPolicy.Basic256Sha256,
    Aes128_Sha256_RsaOaep:    opcua.SecurityPolicy.Aes128_Sha256_RsaOaep,
    Aes256_Sha256_RsaPss:     opcua.SecurityPolicy.Aes256_Sha256_RsaPss,
    Basic128Rsa15:             opcua.SecurityPolicy.Basic128Rsa15,
    Basic256:                  opcua.SecurityPolicy.Basic256,
  };
  return map[policy] || opcua.SecurityPolicy.None;
}

module.exports = {
  DEFAULT_CONNECTION_STRATEGY,
  resolveUserIdentity,
  resolveSecurityMode,
  resolveSecurityPolicy,
};
