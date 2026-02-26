/**
 * @file opcua-rights.js
 * @description OPC UA Rights node — enriches messages with access level, role, and permissions.
 *
 * This is a pure message transformer with no OPC UA connection.
 * It builds access level flags, role, and permission flags from checkbox
 * configuration and attaches them to the message for downstream use
 * (e.g. OPC UA Server addVariable).
 *
 * Supports chaining: if `msg.permissions` already exists as an array,
 * this node's permissions are appended (enabling multi-role setups).
 *
 * Output additions:
 *   msg.accessLevel        — numeric access level flag
 *   msg.userAccessLevel    — numeric user access level flag (same as accessLevel)
 *   msg.accessRestrictions — access restriction flag (None)
 *   msg.permissions        — array of { roleId, permissions } objects
 */

"use strict";

const opcua = require("node-opcua");

// ── Role key → WellKnownRoles mapping ────────────────────────────────────────
const ROLE_MAP = {
  a: opcua.WellKnownRoles.Anonymous,
  u: opcua.WellKnownRoles.AuthenticatedUser,
  b: opcua.WellKnownRoles.Observer,
  e: opcua.WellKnownRoles.Engineer,
  o: opcua.WellKnownRoles.Operator,
  c: opcua.WellKnownRoles.ConfigureAdmin,
  s: opcua.WellKnownRoles.SecurityAdmin,
  v: opcua.WellKnownRoles.Supervisor,
};

// ── Access level flag definitions ────────────────────────────────────────────
const ACCESS_LEVEL_FLAGS = [
  { key: "accessLevelCurrentRead",    flag: "CurrentRead" },
  { key: "accessLevelCurrentWrite",   flag: "CurrentWrite" },
  { key: "accessLevelStatusWrite",    flag: "StatusWrite" },
  { key: "accessLevelHistoryRead",    flag: "HistoryRead" },
  { key: "accessLevelHistoryWrite",   flag: "HistoryWrite" },
  { key: "accessLevelSemanticChange", flag: "SemanticChange" },
];

// ── Permission flag definitions ──────────────────────────────────────────────
const PERMISSION_FLAGS = [
  { key: "permissionBrowse",          flag: "Browse" },
  { key: "permissionRead",            flag: "Read" },
  { key: "permissionWrite",           flag: "Write" },
  { key: "permissionWriteAttribute",  flag: "WriteAttribute" },
  { key: "permissionReadRole",        flag: "ReadRolePermissions" },
  { key: "permissionWriteRole",       flag: "WriteRolePermissions" },
  { key: "permissionReadHistory",     flag: "ReadHistory" },
  { key: "permissionWriteHistory",    flag: "WriteHistorizing" },
  { key: "permissionInsertHistory",   flag: "InsertHistory" },
  { key: "permissionModifyHistory",   flag: "ModifyHistory" },
  { key: "permissionDeleteHistory",   flag: "DeleteHistory" },
  { key: "permissionReceiveEvents",   flag: "ReceiveEvents" },
  { key: "permissionCall",            flag: "Call" },
  { key: "permissionAddReference",    flag: "AddReference" },
  { key: "permissionRemoveReference", flag: "RemoveReference" },
  { key: "permissionDeleteNode",      flag: "DeleteNode" },
  { key: "permissionAddNode",         flag: "AddNode" },
];

module.exports = function (RED) {

  function OpcUaRightsNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    this.name = config.name || "";

    // ── Pre-compute flags from static configuration ──────────────────────
    const accessLevelString = buildFlagString(config, ACCESS_LEVEL_FLAGS);
    const permissionString  = buildFlagString(config, PERMISSION_FLAGS);
    const roleId            = ROLE_MAP[config.role] || ROLE_MAP.a;

    const accessLevel      = opcua.makeAccessLevelFlag(accessLevelString || "CurrentRead");
    const permissionFlag   = opcua.makePermissionFlag(permissionString || "Browse");

    // ── Input handler ────────────────────────────────────────────────────
    node.on("input", (msg, send, done) => {
      msg.accessLevel = accessLevel;
      msg.userAccessLevel = accessLevel; // Same flags for user access level
      msg.accessRestrictions = opcua.AccessRestrictionsFlag.None;

      // Support chaining: append to existing permissions array
      const entry = { roleId, permissions: permissionFlag };
      if (Array.isArray(msg.permissions)) {
        msg.permissions = msg.permissions.concat([entry]);
      } else {
        msg.permissions = [entry];
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType("opcua-rights", OpcUaRightsNode);
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Build a pipe-separated flag string from config checkboxes.
 * @param {object} config — node config
 * @param {Array} definitions — array of { key, flag } objects
 * @returns {string} e.g. "CurrentRead | CurrentWrite | HistoryRead"
 */
function buildFlagString(config, definitions) {
  const flags = definitions
    .filter(({ key }) => config[key] === true)
    .map(({ flag }) => flag);
  return flags.join(" | ");
}
