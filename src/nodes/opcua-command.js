/**
 * @file opcua-command.js
 * @description OPC UA Command node — sets `msg.command` and command-specific
 * configuration for a downstream OPC UA Server node.
 *
 * Works the same way as the opcua-action node does for the client:
 * configure once in the editor, pass through on every trigger.
 *
 * Depending on the selected command, additional message properties are set:
 *   - addVariable:          msg.items [{ nodeId, datatype, value, description, browseName, displayName }]
 *   - addFolder:            msg.items [{ nodeId, browseName, displayName, description }]
 *   - addExtensionObject:   msg.items [{ nodeId, typeId }]
 *   - setFolder:            msg.nodeId
 *   - deleteNode:           msg.nodeId or msg.items [{ nodeId }]
 *   - addEquipment/Asset:   msg.nodeName
 *   - addMethod:            msg.parentNodeId, msg.methodName
 *   - bindMethod:           msg.nodeId
 *   - installHistorian:     msg.items [{ nodeId }]
 *   - installDiscreteAlarm: msg.items [{ nodeId }], msg.priority, msg.alarmText
 *   - installLimitAlarm:    msg.items [{ nodeId }], msg.hh/h/l/ll
 *   - addFile:              msg.nodeId, msg.fileName
 *   - registerNamespace:    msg.namespaceUri
 *   - getNamespaceIndex:    msg.namespaceUri
 *   - saveAddressSpace:     msg.namespaceIndex, msg.filename
 *   - loadAddressSpace:     msg.filename
 *   - startOPCUAServer:    (no extra properties)
 *   - closeOPCUAServer:    (no extra properties)
 *   - restartOPCUAServer:  (no extra properties)
 *
 * ─── Outputs ──────────────────────────────────────────────────────────
 *   Output 1 — Message with `msg.command` and properties set
 */

'use strict';

module.exports = function (RED) {
  function OpcUaCommandNode(config) {
    RED.nodes.createNode(this, config);

    // ── Common ─────────────────────────────────────────────────────────
    this.command = config.command || '';
    this.name = config.name || '';

    // ── Node identification ─────────────────────────────────────────────
    this.nodeId = config.nodeId || '';
    this.datatype = config.datatype || 'Double';
    this.value = config.value !== undefined ? config.value : '';
    this.description = config.description || '';
    this.browseName = config.browseName || '';
    this.displayName = config.displayName || '';

    // ── Equipment / Physical Asset ──────────────────────────────────────
    this.nodeName = config.nodeName || '';

    // ── Method ──────────────────────────────────────────────────────────
    this.parentNodeId = config.parentNodeId || '';
    this.methodName = config.methodName || '';

    // ── Alarms ──────────────────────────────────────────────────────────
    this.priority = Number(config.priority) || 100;
    this.alarmText = config.alarmText || '';
    this.highHigh = Number(config.highHigh) || 90;
    this.high = Number(config.high) || 70;
    this.low = Number(config.low) || 30;
    this.lowLow = Number(config.lowLow) || 10;

    // ── Extension Object ────────────────────────────────────────────────
    this.typeId = config.typeId || '';

    // ── File ────────────────────────────────────────────────────────────
    this.fileName = config.fileName || '';

    // ── Namespace ───────────────────────────────────────────────────────
    this.namespaceUri = config.namespaceUri || '';
    this.namespaceIndex = config.namespaceIndex || '1';

    const node = this;

    // ── Input handler ────────────────────────────────────────────────────
    node.on('input', (msg, send, done) => {
      const command = node.command;

      // Always set msg.command (like msg.action on the client)
      msg.command = command;

      switch (command) {
        // ── Address Space: Variables ──────────────────────────────────
        case 'addVariable': {
          // Build items from config if not already present
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [
              {
                nodeId: node.nodeId,
                datatype: node.datatype,
                value: node.value,
                description: node.description,
                browseName: node.browseName,
                displayName: node.displayName,
              },
            ];
          }
          break;
        }

        case 'addExtensionObject': {
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [
              {
                nodeId: node.nodeId,
                typeId: node.typeId,
              },
            ];
          }
          break;
        }

        // ── Address Space: Folders ────────────────────────────────────
        case 'addFolder': {
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [
              {
                nodeId: node.nodeId,
                browseName: node.browseName,
                displayName: node.displayName,
                description: node.description,
              },
            ];
          }
          break;
        }

        case 'setFolder':
          msg.nodeId = msg.nodeId || node.nodeId;
          break;

        // ── Address Space: Deletion ───────────────────────────────────
        case 'deleteNode':
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.nodeId = msg.nodeId || node.nodeId;
          }
          break;

        // ── Address Space: Equipment ──────────────────────────────────
        case 'addEquipment':
        case 'addPhysicalAsset':
          msg.nodeName = msg.nodeName || node.nodeName;
          break;

        // ── Methods ───────────────────────────────────────────────────
        case 'addMethod':
          msg.parentNodeId = msg.parentNodeId || node.parentNodeId;
          msg.methodName = msg.methodName || node.methodName;
          break;

        case 'bindMethod':
          msg.nodeId = msg.nodeId || node.nodeId;
          // msg.code must come from upstream (Function node)
          break;

        // ── Monitoring: Historian ─────────────────────────────────────
        case 'installHistorian':
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [{ nodeId: node.nodeId }];
          }
          break;

        // ── Monitoring: Alarms ────────────────────────────────────────
        case 'installDiscreteAlarm':
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [{ nodeId: node.nodeId }];
          }
          msg.priority = msg.priority || node.priority;
          msg.alarmText = msg.alarmText || node.alarmText;
          break;

        case 'installLimitAlarm':
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            msg.items = [{ nodeId: node.nodeId }];
          }
          msg.priority = msg.priority || node.priority;
          msg.alarmText = msg.alarmText || node.alarmText;
          msg.hh = msg.hh ?? node.highHigh;
          msg.h = msg.h ?? node.high;
          msg.l = msg.l ?? node.low;
          msg.ll = msg.ll ?? node.lowLow;
          break;

        // ── Files ─────────────────────────────────────────────────────
        case 'addFile':
          msg.nodeId = msg.nodeId || node.nodeId;
          msg.fileName = msg.fileName || node.fileName;
          break;

        // ── Namespaces ────────────────────────────────────────────────
        case 'registerNamespace':
        case 'getNamespaceIndex':
          msg.namespaceUri = msg.namespaceUri || node.namespaceUri;
          break;

        case 'getNamespaces':
          break;

        // ── Persistence ───────────────────────────────────────────────
        case 'saveAddressSpace':
          msg.namespaceIndex = msg.namespaceIndex || node.namespaceIndex;
          msg.filename = msg.filename || node.fileName;
          break;

        case 'loadAddressSpace':
          msg.filename = msg.filename || node.fileName;
          break;

        case 'bindVariables':
          break;

        // ── Users ─────────────────────────────────────────────────────
        case 'setUsers':
          // Users array must come from upstream msg
          break;

        // ── Lifecycle ─────────────────────────────────────────────────        case "startOPCUAServer":
        case 'closeOPCUAServer':
        case 'restartOPCUAServer':
          break;

        default:
          node.warn(`Unknown server command: ${command}`);
          done();
          return;
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType('opcua-command', OpcUaCommandNode);
};
