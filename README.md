# @brdk/node-red-opcua

A modern, clean Node-RED OPC UA library for interacting with OPC UA servers and building your own.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D2.0.0-red.svg)](https://nodered.org)
[![node-opcua](https://img.shields.io/badge/node--opcua-2.x-green.svg)](https://node-opcua.github.io)

---

## Nodes

### Client Nodes

| Node | Description |
|------|-------------|
| **OPC UA Client** | Main workhorse — reads, writes, subscribes, browses, calls methods, transfers files, and more. Supports 20+ actions with persistent connection management. 3 outputs: data, status, batch. |
| **OPC UA Endpoint** | Configuration node storing server connection details — URL, security mode/policy, and authentication credentials. Referenced by Client, Method, and Event nodes. |
| **OPC UA Item** | Prepares a single OPC UA node reference (`nodeId`, `datatype`, `browseName`) on `msg.items` for downstream Client operations. |
| **OPC UA Smart Item** | Multi-item selector with a live address space browser in the editor. Outputs one or more items with optional static values. |
| **OPC UA Action** | Configures the action type (subscribe, browse, history, acknowledge, method, etc.) and action-specific settings on the message for the Client node. |
| **OPC UA Event** | Sets `msg.topic` and `msg.eventTypeIds` for event subscriptions. Supports standard and custom OPC UA event types. |
| **OPC UA Method** | Calls a single OPC UA method with up to 3 input arguments and returns the result. Opens its own connection per invocation. |

### Server Nodes

| Node | Description |
|------|-------------|
| **OPC UA Server** | Creates and manages a full OPC UA server with dynamic address space management — variables, folders, methods, alarms, files, and namespaces. 2 outputs: session events, status. |
| **OPC UA Command** | Sets `msg.command` for server-side operations — addVariable, deleteNode, addMethod, installAlarm, and more. |
| **OPC UA Rights** | Builds OPC UA access level flags, user roles, and permission settings from checkboxes. Attaches to `msg` for variable creation. |

### Utility Nodes

| Node | Description |
|------|-------------|
| **OPC UA Discovery** | Starts a local OPC UA Discovery Server (LDS) on port 4840 and returns registered server URLs. |

---

## Architecture

```
 ┌──────────────── Client Flow ────────────────────────┐
 │                                                     │
 │   [inject] → [Item / Smart Item] → [Action]         │
 │                                       ↓             │
 │                  [Endpoint] ──→ [OPC UA Client]     │
 │                                    ↓   ↓   ↓        │
 │                               data  status  batch   │
 │                                                     │
 ├──────────────── Server Flow ────────────────────────┤
 │                                                     │
 │   [inject] → [Rights] → [Command] → [OPC UA Server] │
 │                                        ↓   ↓        │
 │                                    session  status  │
 │                                                     │
 └─────────────────────────────────────────────────────┘
```

---

## Todo

### OPC UA Client
- [] Testing
- [] JSON Serilazation of outputs.
- [] FIX UNSUBSCRIBE so it unsubs the right node on the right subscribtion id.

### OPC UA Server
- [] Testing

### OPC UA Item
- [x] Works like intended 

### OPC UA Smart Item
- [] Automatic value type from browse


### OPC UA Endpoint
- [x] Works like intended

### OPC UA Event
- [] Testing
- [] Alignment with `.items` data structure 

### OPC UA Method
- [] Testing
- [] Alignment with `.items` data structure 

### OPC UA Discovery
- [] Testing
- may be removed depending on the demand of this function

### General
- [] Unit and feautre testing
- 


---

## Installation
This project has yet to be packaged by npm so currently you can do:
```bash
cd ~/.node-red
npm install https://github.com/Claus-BR/BRDK-Node-RED-OPCUA
```

Then restart Node-RED and the nodes will appear under the **BRDK OPCUA** category in the palette.

---

## License

[Apache-2.0](LICENSE)
