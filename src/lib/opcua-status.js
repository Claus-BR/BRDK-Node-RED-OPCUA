/**
 * @file opcua-status.js
 * @description Centralized node status management for all OPC UA nodes.
 *
 * Provides a consistent look-and-feel for node status indicators across the
 * entire library, and a single source of truth for status values/colors.
 */

"use strict";

// ── Status definitions ─────────────────────────────────────────────────────────
//
// Each entry maps a human-readable status key to a Node-RED status object:
//   { fill: "green"|"yellow"|"red"|"blue"|"grey", shape: "dot"|"ring", text }
//
// Naming convention:
//   - green/dot   = actively working (reading, writing, subscribed, etc.)
//   - green/ring  = initializing / transient success (connected, initialized)
//   - yellow/dot  = transitional (connecting, reconnecting, closing)
//   - red/ring    = error / disconnected / invalid
//   - blue/ring   = idle / waiting
//   - grey/ring   = cleared / unknown

const STATUS_MAP = {
  // ── Initialization & connection ──────────────────────────────────────────
  "client created":    { fill: "green",  shape: "ring", text: "creating client" },
  "connected":          { fill: "green",  shape: "ring", text: "connected" },
  "initialized":        { fill: "green",  shape: "ring", text: "initialized" },
  "session active":     { fill: "green",  shape: "dot",  text: "session active" },
  "keepalive":          { fill: "green",  shape: "ring", text: "keepalive" },
  "re-established":     { fill: "green",  shape: "ring", text: "re-established" },

  // ── Transitional ────────────────────────────────────────────────────────
  "connecting":         { fill: "yellow", shape: "dot",  text: "connecting" },
  "reconnecting":       { fill: "yellow", shape: "dot",  text: "reconnecting" },
  "closing":            { fill: "yellow", shape: "dot",  text: "closing" },

  // ── Active operations ────────────────────────────────────────────────────
  "reading":            { fill: "green",  shape: "dot",  text: "reading" },
  "writing":            { fill: "green",  shape: "dot",  text: "writing" },
  "subscribing":        { fill: "green",  shape: "dot",  text: "subscribing" },
  "subscribed":         { fill: "green",  shape: "dot",  text: "subscribed" },
  "monitoring":         { fill: "green",  shape: "dot",  text: "monitoring" },
  "browsing":           { fill: "green",  shape: "dot",  text: "browsing" },
  "browse done":        { fill: "green",  shape: "dot",  text: "browse done" },
  "value changed":      { fill: "green",  shape: "dot",  text: "value changed" },
  "value written":      { fill: "green",  shape: "dot",  text: "value written" },
  "values written":     { fill: "green",  shape: "dot",  text: "values written" },
  "calling method":     { fill: "green",  shape: "dot",  text: "calling method" },
  "method executed":    { fill: "green",  shape: "dot",  text: "method executed" },
  "reading multiple":   { fill: "green",  shape: "dot",  text: "reading multiple" },
  "item stored":        { fill: "green",  shape: "ring", text: "item stored" },
  "items cleared":      { fill: "green",  shape: "ring", text: "items cleared" },
  "event received":     { fill: "green",  shape: "dot",  text: "event received" },
  "acknowledging":      { fill: "green",  shape: "dot",  text: "acknowledging" },

  // ── Errors ───────────────────────────────────────────────────────────────
  "error":              { fill: "red",    shape: "ring", text: "error" },
  "disconnected":       { fill: "red",    shape: "ring", text: "disconnected" },
  "terminated":         { fill: "red",    shape: "ring", text: "terminated" },
  "session closed":     { fill: "red",    shape: "ring", text: "session closed" },
  "invalid session":    { fill: "red",    shape: "ring", text: "invalid session" },
  "invalid endpoint":   { fill: "red",    shape: "ring", text: "invalid endpoint" },
  "invalid certificate":{ fill: "red",    shape: "ring", text: "invalid certificate" },
  "no session":         { fill: "red",    shape: "ring", text: "no session" },
  "subscription error": { fill: "red",    shape: "ring", text: "subscription error" },
  "no items":           { fill: "red",    shape: "ring", text: "no items to process" },
  "write error":        { fill: "red",    shape: "ring", text: "write error" },
  "read error":         { fill: "red",    shape: "ring", text: "read error" },
  "method error":       { fill: "red",    shape: "ring", text: "method error" },

  // ── Idle / default ───────────────────────────────────────────────────────
  "waiting":            { fill: "blue",   shape: "ring", text: "waiting" },
  "idle":               { fill: "grey",   shape: "ring", text: "idle" },
};

/**
 * Look up a canonical status object by key.
 *
 * @param {string} statusKey - One of the keys defined in STATUS_MAP.
 * @returns {{ fill: string, shape: string, text: string }}
 */
function getStatus(statusKey) {
  return STATUS_MAP[statusKey] || { fill: "blue", shape: "ring", text: statusKey || "waiting" };
}

/**
 * Build a status object with extra detail appended to the text.
 *
 * @param {string} statusKey - Base status key from STATUS_MAP.
 * @param {string} detail    - Extra detail to append (e.g. error message).
 * @returns {{ fill: string, shape: string, text: string }}
 */
function getStatusWithDetail(statusKey, detail) {
  const base = getStatus(statusKey);
  return { ...base, text: detail ? `${base.text}: ${detail}` : base.text };
}

module.exports = {
  STATUS_MAP,
  getStatus,
  getStatusWithDetail,
};
