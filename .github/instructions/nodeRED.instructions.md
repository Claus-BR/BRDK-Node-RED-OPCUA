---
applyTo: "**/*.{js,ts,html}"
description: "Node-RED platform expert reference: creating custom nodes, runtime API, editor API, messages, context, error handling, and best practices"
name: "Node-RED Expert Reference"
---

# Node-RED Expert Reference

> Based on [Node-RED Official Documentation](https://nodered.org/docs/) — comprehensive reference for the node-red-contrib-opcua project.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Node Architecture — File Pairs](#node-architecture--file-pairs)
3. [JavaScript File (.js) — Runtime Behaviour](#javascript-file-js--runtime-behaviour)
4. [HTML File (.html) — Editor Definition](#html-file-html--editor-definition)
5. [Node Definition Object — Full Property Reference](#node-definition-object--full-property-reference)
6. [Node Properties & defaults](#node-properties--defaults)
7. [Node Credentials](#node-credentials)
8. [Node Appearance](#node-appearance)
9. [Node Edit Dialog](#node-edit-dialog)
10. [Node Status](#node-status)
11. [Configuration Nodes](#configuration-nodes)
12. [Context — Node / Flow / Global](#context--node--flow--global)
13. [Working with Messages](#working-with-messages)
14. [Writing Functions (Function Node)](#writing-functions-function-node)
15. [Error Handling](#error-handling)
16. [Environment Variables](#environment-variables)
17. [Internationalisation (i18n)](#internationalisation-i18n)
18. [Help Text Style Guide](#help-text-style-guide)
19. [Adding Example Flows](#adding-example-flows)
20. [Loading Extra Editor Resources](#loading-extra-editor-resources)
21. [Packaging & Publishing](#packaging--publishing)
22. [Subflow Modules](#subflow-modules)
23. [Unit Testing with node-red-node-test-helper](#unit-testing-with-node-red-node-test-helper)
24. [General Design Principles](#general-design-principles)

---

## Core Concepts

Node-RED is a low-code, event-driven programming platform built on Node.js.

- **Flows** are the primary artefact — directed graphs of **nodes** connected by **wires**.
- **Messages** (`msg`) are plain JavaScript objects passed between nodes. By convention, `msg.payload` carries the main data.
- Every message gets a unique `msg._msgid` assigned by the runtime.
- **Context** stores state across messages at three scopes: Node, Flow, Global.
- **Palette** is the sidebar list of available node types, organised into categories.
- The **Editor** is a browser-based UI; the **Runtime** is the server-side Node.js process.

---

## Node Architecture — File Pairs

Every custom node consists of **two files** plus a `package.json`:

| File | Purpose |
|------|---------|
| `<node>.js` | **Runtime** behaviour: constructor, input handling, output, close |
| `<node>.html` | **Editor** definition: registration, edit template, help text |
| `package.json` | Declares the node to the runtime via the `"node-red"` section |

### package.json — node-red section

```json
{
  "name": "@myScope/node-red-contrib-example",
  "version": "1.0.0",
  "node-red": {
    "version": ">=2.0.0",
    "nodes": {
      "example": "example/example.js"
    }
  },
  "keywords": ["node-red"]
}
```

- `"nodes"` maps a logical node name → the `.js` file path.
- `"version"` under `node-red` specifies the minimum Node-RED version required.
- Add `"node-red"` to `keywords` **only** when the node is stable, tested, and documented.

---

## JavaScript File (.js) — Runtime Behaviour

The `.js` file is a Node.js module exporting a single function that receives the `RED` runtime API object.

### Complete Skeleton

```js
module.exports = function(RED) {

    function MyNode(config) {
        RED.nodes.createNode(this, config);  // MUST be the first call

        // Read properties from the flow editor config
        this.myProp = config.myProp;

        // Access a config node
        this.server = RED.nodes.getNode(config.server);

        // Access credentials
        var username = this.credentials.username;
        var password = this.credentials.password;

        var node = this;

        // ─── Receive messages ───
        this.on('input', function(msg, send, done) {
            // For Node-RED 0.x backwards compatibility:
            send = send || function() { node.send.apply(node, arguments); };

            // Process message
            msg.payload = doSomething(msg.payload);

            // Send output
            send(msg);

            // Signal completion (Node-RED 1.0+)
            if (done) { done(); }
        });

        // ─── Cleanup on redeploy / removal ───
        this.on('close', function(removed, done) {
            // removed = true  → node deleted/disabled
            // removed = false → node being restarted (redeploy)
            cleanupResources(function() {
                done();
            });
        });
    }

    RED.nodes.registerType("my-node", MyNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
```

### Node Constructor Rules

1. **Always** call `RED.nodes.createNode(this, config)` first.
2. **Always** register the type with `RED.nodes.registerType(typeName, Constructor, options)`.
3. The `typeName` string MUST match `data-template-name` / `data-help-name` in the HTML file and the first argument to `RED.nodes.registerType` in the HTML `<script>`.

### Receiving Messages — `input` Event

```js
this.on('input', function(msg, send, done) {
    // msg  — the incoming message object
    // send — function to emit downstream (Node-RED 1.0+)
    // done — function to signal message handling is complete (Node-RED 1.0+)
});
```

- **Node-RED 0.x compatibility**: check `send` / `done` exist before calling.
- The `done` call is essential for proper message tracking in the runtime.

### Sending Messages

```js
// From input handler — use the provided send function
send(msg);

// From outside input handler (e.g., event-driven source node)
this.send(msg);

// Sending null → no message sent
this.send(null);
```

#### Multiple Outputs

```js
// Two outputs: msg goes to output 1, msg2 to output 2
send([msg, msg2]);
```

#### Multiple Messages to One Output

```js
// Send 3 messages on output 1, 1 message on output 2
send([[msg1, msg2, msg3], msg4]);
```

### Closing the Node — `close` Event

```js
// Synchronous cleanup
this.on('close', function() { /* tidy up */ });

// Asynchronous cleanup
this.on('close', function(done) {
    doAsyncCleanup(function() { done(); });
});

// With removed flag (Node-RED 0.17+)
this.on('close', function(removed, done) {
    if (removed) {
        // Node has been deleted/disabled
    } else {
        // Node is being restarted
    }
    done();
});
```

- **Timeout**: the runtime waits a maximum of **15 seconds** for `done()` to be called (since 0.17). After that it logs an error and continues.

### Logging

```js
this.log("Informational message");
this.warn("Warning — also appears in Debug sidebar");
this.error("Error — also appears in Debug sidebar");
this.trace("Fine-grained internal detail");    // since 0.17
this.debug("Debugging-level detail");          // since 0.17
```

### Setting Status

```js
this.status({ fill: "green", shape: "dot", text: "connected" });
this.status({ fill: "red", shape: "ring", text: "disconnected" });
this.status({ fill: "yellow", shape: "ring", text: "reconnecting..." });
this.status({});  // Clear status
```

### Custom Settings (exposed to editor)

```js
RED.nodes.registerType("my-node", MyNode, {
    settings: {
        myNodeColour: {
            value: "red",
            exportable: true    // makes it available in the editor
        }
    }
});
// Runtime access: RED.settings.myNodeColour
// Editor access:  RED.settings.myNodeColour
```

- Setting names MUST be prefixed with the node type (camelCase, no hyphens).

---

## HTML File (.html) — Editor Definition

The `.html` file contains **three** `<script>` blocks:

### 1. Node Registration (JavaScript)

```html
<script type="text/javascript">
    RED.nodes.registerType('my-node', {
        category:    'function',          // Palette category
        color:       '#a6bbcf',           // Background colour
        defaults: {
            name:   { value: "" },
            myProp: { value: "", required: true }
        },
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        },
        inputs:      1,                   // 0 or 1
        outputs:     1,                   // 0 or more
        icon:        "file.svg",
        label:       function() { return this.name || "my-node"; },
        paletteLabel: "my-node",
        labelStyle:  function() { return this.name ? "node_label_italic" : ""; },
        inputLabels: "input",
        outputLabels: ["output"],
        align:       'left',              // or 'right' for end-of-flow nodes
        oneditprepare: function() { /* runs before dialog opens */ },
        oneditsave:    function() { /* runs when OK is clicked */ },
        oneditcancel:  function() { /* runs when Cancel is clicked */ },
        oneditdelete:  function() { /* config node delete button */ },
        oneditresize:  function(size) { /* dialog resize */ },
        onpaletteadd:    function() { /* node type added to palette */ },
        onpaletteremove: function() { /* node type removed from palette */ }
    });
</script>
```

### 2. Edit Template

```html
<script type="text/html" data-template-name="my-node">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
    <div class="form-row">
        <label for="node-input-myProp"><i class="fa fa-cog"></i> My Prop</label>
        <input type="text" id="node-input-myProp">
    </div>
    <div class="form-tips"><b>Tip:</b> This is a helpful tip.</div>
</script>
```

#### Edit Template Rules

- Each row: `<div class="form-row">` containing a `<label>` + `<input>`.
- Input IDs: `node-input-<propertyname>` for regular nodes.
- Input IDs: `node-config-input-<propertyname>` for configuration nodes.
- Icons use [Font Awesome 4.7](https://fontawesome.com/v4.7.0/icons/): `<i class="fa fa-tag"></i>`.
- `<input type="text">` for strings/numbers, `<input type="checkbox">` for booleans, `<select>` for enums.

### 3. Help Text

```html
<script type="text/html" data-help-name="my-node">
    <p>A brief description of what the node does. This first paragraph is used as the palette tooltip.</p>

    <h3>Inputs</h3>
    <dl class="message-properties">
        <dt>payload <span class="property-type">string | buffer</span></dt>
        <dd>the payload to process.</dd>
        <dt class="optional">topic <span class="property-type">string</span></dt>
        <dd>the topic of the message.</dd>
    </dl>

    <h3>Outputs</h3>
    <dl class="message-properties">
        <dt>payload <span class="property-type">string</span></dt>
        <dd>the result.</dd>
    </dl>

    <h3>Details</h3>
    <p><code>msg.payload</code> is processed and the result is sent as the output.</p>

    <h3>References</h3>
    <ul>
        <li><a href="https://example.com">API Documentation</a> — external reference</li>
        <li><a href="https://github.com/example/repo">GitHub</a> — source repository</li>
    </ul>
</script>
```

Since Node-RED 2.1, help text can use `type="text/markdown"` instead of HTML. When using markdown, ensure **no leading whitespace** inside the `<script>` tags.

---

## Node Definition Object — Full Property Reference

| Property | Type | Description |
|----------|------|-------------|
| `category` | string | Palette category. Use `'config'` for config nodes. |
| `color` | string | Hex background colour (e.g., `'#a6bbcf'`). |
| `defaults` | object | Editable properties with `value`, `required`, `validate`, `type` entries. |
| `credentials` | object | Credential properties with `type: "text"` or `type: "password"`. |
| `inputs` | number | `0` or `1`. |
| `outputs` | number | `0` or more. Can be dynamic if listed in `defaults`. |
| `icon` | string\|function | Icon filename, Font Awesome ref (`"font-awesome/fa-bolt"`), or function. |
| `label` | string\|function | Workspace label. |
| `paletteLabel` | string\|function | Override label shown in palette. |
| `labelStyle` | string\|function | CSS class: `"node_label"` (default) or `"node_label_italic"`. |
| `inputLabels` | string\|function | Hover label for input port. |
| `outputLabels` | string\|function\|array | Hover label(s) for output port(s). |
| `align` | string | `'left'` (default) or `'right'`. |
| `button` | object | Adds edge button (`onclick`, `enabled`, `visible`, `toggle`). |
| `oneditprepare` | function | Called before edit dialog is displayed. |
| `oneditsave` | function | Called when edit dialog is confirmed. |
| `oneditcancel` | function | Called when edit dialog is cancelled. |
| `oneditdelete` | function | Config node delete button. |
| `oneditresize` | function | Called when edit dialog is resized. |
| `onpaletteadd` | function | Called when node type is added to palette. |
| `onpaletteremove` | function | Called when node type is removed from palette. |

---

## Node Properties & defaults

### Property Definition Attributes

```js
defaults: {
    name:       { value: "" },
    count:      { value: 0, required: true, validate: RED.validators.number() },
    pattern:    { value: "", validate: RED.validators.regex(/^[a-z]+$/) },
    server:     { value: "", type: "remote-server" },   // config node reference
    customProp: { value: "", validate: function(v) {
        // 'this' = node being edited (current config, not form)
        // Use jQuery to read form elements for real-time validation:
        var minLen = $("#node-input-count").length
                   ? $("#node-input-count").val()
                   : this.count;
        return v.length > minLen;
    }}
}
```

| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | any | Default value for new instances. |
| `required` | boolean | If `true`, invalid when null or empty string. |
| `validate` | function | Returns `true` if valid. Context is the node. |
| `type` | string | Type name of a configuration node. |

### Reserved Property Names — DO NOT USE

- Single characters: `x`, `y`, `z`, `d`, `g`, `l` (used internally, others reserved).
- `id`, `type`, `wires`, `inputs`, `outputs` (except `outputs` may appear in `defaults` to allow dynamic output count — see the Function node).

### Built-in Validators

```js
RED.validators.number()          // Must be a number
RED.validators.regex(re)         // Must match regex
```

---

## Node Credentials

Credentials are stored separately from the flow file and never exported.

### Defining Credentials

**HTML registration:**

```js
credentials: {
    username: { type: "text" },
    password: { type: "password" }
}
```

**HTML template** — same `node-input-<name>` id convention:

```html
<div class="form-row">
    <label for="node-input-username"><i class="fa fa-user"></i> Username</label>
    <input type="text" id="node-input-username">
</div>
<div class="form-row">
    <label for="node-input-password"><i class="fa fa-lock"></i> Password</label>
    <input type="password" id="node-input-password">
</div>
```

**JS registration:**

```js
RED.nodes.registerType("my-node", MyNode, {
    credentials: {
        username: { type: "text" },
        password: { type: "password" }
    }
});
```

### Accessing Credentials

**Runtime:**

```js
var username = this.credentials.username;
var password = this.credentials.password;
```

**Editor:**

- `type: "text"` → available as `this.credentials.username`
- `type: "password"` → NOT available. Instead `this.credentials.has_password` is a boolean.

---

## Node Appearance

### Background Colour

```js
color: '#a6bbcf'
```

Common palette colours: `#3FADB5`, `#87A980`, `#A6BBCF`, `#C0DEED`, `#C7E9C0`, `#D7D7A0`, `#DEB887`, `#DEBD5C`, `#E2D96E`, `#E6E0F8`, `#E9967A`, `#F3B567`, `#FDD0A2`, `#FFAAAA`, `#FFCC66`.

### Icons

```js
icon: "file.svg"                         // Stock icon
icon: "icons/my-custom-icon.svg"         // Custom icon in icons/ directory
icon: "font-awesome/fa-database"         // Font Awesome 4.7
icon: function() { return "file.svg"; }  // Dynamic
```

- Custom icons: place in an `icons/` directory next to `.js` and `.html`.
- Requirements: white on transparent, 2:3 aspect ratio, minimum 40×60px.
- Since Node-RED 1.0, stock icons are SVG (PNG requests auto-swap to SVG).

### Labels

```js
label: function() { return this.name || "default-label"; }
paletteLabel: "My Node"
labelStyle: function() { return this.name ? "node_label_italic" : ""; }
```

### Port Labels

```js
inputLabels: "request input"
outputLabels: ["success", "error"]
outputLabels: function(index) { return "output " + index; }
```

### Alignment

```js
align: 'right'  // For end-of-flow nodes (e.g., Debug)
```

### Buttons

```js
button: {
    enabled: function() { return !this.changed; },
    visible: function() { return this.hasButton; },
    onclick: function() { /* button action */ },
    toggle: "buttonState"  // for toggle buttons
}
```

---

## Node Edit Dialog

### Form Structure

```html
<script type="text/html" data-template-name="my-node">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
</script>
```

### TypedInput Widget

The `TypedInput` is a jQuery widget for typed property editing. Initialise in `oneditprepare`:

```js
oneditprepare: function() {
    // String / Number / Boolean selector
    $("#node-input-myProp").typedInput({
        type: "str",
        types: ["str", "num", "bool"],
        typeField: "#node-input-myProp-type"   // hidden input to store type
    });

    // msg / flow / global context selector
    $("#node-input-target").typedInput({
        type: "msg",
        types: ["msg", "flow", "global"],
        typeField: "#node-input-target-type"
    });

    // JSON editor
    $("#node-input-jsonConfig").typedInput({
        type: "json",
        types: ["json"]
    });

    // Select box
    $("#node-input-fruit").typedInput({
        types: [{
            value: "fruit",
            options: [
                { value: "apple", label: "Apple" },
                { value: "banana", label: "Banana" },
                { value: "cherry", label: "Cherry" }
            ]
        }]
    });
}
```

Corresponding hidden input in the template:

```html
<input type="hidden" id="node-input-myProp-type">
```

### Multi-line Text Editor (Ace/Monaco)

```html
<div style="height: 250px; min-height: 150px;" class="node-text-editor" id="node-input-my-editor"></div>
```

```js
oneditprepare: function() {
    this.editor = RED.editor.createEditor({
        id: 'node-input-my-editor',
        mode: 'ace/mode/javascript',
        value: this.myCode
    });
},
oneditsave: function() {
    this.myCode = this.editor.getValue();
    this.editor.destroy();
    delete this.editor;
},
oneditcancel: function() {
    this.editor.destroy();
    delete this.editor;
}
```

### Buttons in Edit Dialog

```html
<button type="button" class="red-ui-button">Plain</button>
<button type="button" class="red-ui-button red-ui-button-small">Small</button>
```

Toggle button group:

```html
<span class="button-group">
    <button type="button" class="red-ui-button toggle selected my-group">A</button><button type="button" class="red-ui-button toggle my-group">B</button>
</span>
```

**Note:** No whitespace between adjacent `<button>` elements in a button-group.

---

## Node Status

### Setting Status from Runtime

```js
this.status({ fill: "red", shape: "ring", text: "disconnected" });
this.status({ fill: "green", shape: "dot", text: "connected" });
this.status({ fill: "yellow", shape: "dot", text: "processing..." });
this.status({ fill: "blue", shape: "ring", text: "waiting" });
this.status({ fill: "grey", shape: "ring", text: "idle" });
this.status({});  // Clear
```

### Status Object Properties

| Property | Values |
|----------|--------|
| `fill` | `"red"`, `"green"`, `"yellow"`, `"blue"`, `"grey"` |
| `shape` | `"ring"`, `"dot"` |
| `text` | Short string (< 20 characters recommended) |

### Status Node

From Node-RED 0.12, the **Status** node catches status updates from other nodes, enabling flow-based handling of status changes (e.g., connection state).

---

## Configuration Nodes

Config nodes **share configuration** between multiple nodes (e.g., connection endpoints, credentials). They are scoped globally by default.

### Defining a Config Node

**HTML:**

```html
<script type="text/javascript">
    RED.nodes.registerType('my-server', {
        category: 'config',                      // ← MUST be 'config'
        defaults: {
            host: { value: "localhost", required: true },
            port: { value: 1234, required: true, validate: RED.validators.number() }
        },
        label: function() { return this.host + ":" + this.port; }
    });
</script>

<script type="text/html" data-template-name="my-server">
    <div class="form-row">
        <label for="node-config-input-host"><i class="fa fa-bookmark"></i> Host</label>
        <input type="text" id="node-config-input-host">   <!-- node-CONFIG-input -->
    </div>
    <div class="form-row">
        <label for="node-config-input-port"><i class="fa fa-bookmark"></i> Port</label>
        <input type="text" id="node-config-input-port">
    </div>
</script>
```

**JS:**

```js
module.exports = function(RED) {
    function MyServerNode(n) {
        RED.nodes.createNode(this, n);
        this.host = n.host;
        this.port = n.port;

        // Often: open a shared connection here

        this.on('close', function(done) {
            // Close shared connection
            done();
        });
    }
    RED.nodes.registerType("my-server", MyServerNode);
};
```

### Two Key Differences from Regular Nodes

1. `category` is `'config'`.
2. Template input IDs use `node-config-input-<propertyname>` (not `node-input-`).

### Using a Config Node

**In the consuming node's defaults:**

```js
defaults: {
    server: { value: "", type: "my-server" }
}
```

**In the consuming node's runtime:**

```js
function MyNode(config) {
    RED.nodes.createNode(this, config);
    this.server = RED.nodes.getNode(config.server);  // ← retrieves config node instance

    if (this.server) {
        // Access this.server.host, this.server.port, etc.
    } else {
        // No config node configured
    }
}
```

The editor automatically provides a `<select>` dropdown populated with available config node instances.

---

## Context — Node / Flow / Global

### Three Scopes

| Scope | Visible To | Access in Custom Node |
|-------|-----------|----------------------|
| Node | Only the node that set the value | `this.context()` |
| Flow | All nodes on the same flow/tab | `this.context().flow` |
| Global | All nodes everywhere | `this.context().global` |

### Accessing Context in Custom Nodes

```js
var nodeContext   = this.context();
var flowContext   = this.context().flow;
var globalContext  = this.context().global;

// Synchronous get/set
var count = flowContext.get("count") || 0;
flowContext.set("count", count + 1);

// Asynchronous get/set
flowContext.get("count", function(err, count) {
    flowContext.set("count", (count || 0) + 1, function(err) { /* done */ });
});

// Get/set multiple values (Node-RED 0.19+)
var values = flowContext.get(["count", "colour"]);
flowContext.set(["count", "colour"], [42, "red"]);

// Keys
var keys = flowContext.keys();
```

### Context in Function Nodes

```js
// Predefined variables:
context.get("key");      // node scope
flow.get("key");         // flow scope
global.get("key");       // global scope
```

### Context Stores

Configure in `settings.js`:

```js
contextStorage: {
    default: "memoryOnly",
    memoryOnly: { module: 'memory' },
    file: { module: 'localfilesystem' }
}
```

Specify store when accessing:

```js
flow.get("count", "file");
flow.set("count", 42, "file");
```

**Important**: Configuration nodes are globally scoped by default and **cannot** assume access to a flow context.

### Subflow Context

From Node-RED 0.20, nodes inside a subflow access the parent flow's context with:

```js
var colour = flow.get("$parent.colour");
```

---

## Working with Messages

### Message Structure

```js
{
    "_msgid": "12345",    // auto-assigned unique ID
    "payload": "...",     // primary data property
    "topic": "...",       // optional topic/routing key
    // ... any other user/node-defined properties
}
```

### Valid Property Types

`Boolean`, `Number`, `String`, `Array`, `Object`, `Buffer`, `null`.

### Best Practices

- **Reuse the received message** rather than creating a new object — preserves existing properties for downstream nodes (e.g., `msg.req`, `msg.res` for HTTP flows).
- When you must create a new message, be aware that it loses all existing properties.
- Use `RED.util.cloneMessage(msg)` to safely clone a message.

### Changing Message Properties

- **Change node**: Set, Change (search/replace on strings), Delete, Move properties — no code required.
- **Function node**: Full JavaScript access.
- **JSONata**: Available in Change nodes for expression-based transforms: `$env('VAR')`, `$sum()`, etc.

### Message Sequences

Ordered series of related messages, linked via `msg.parts`:

```js
msg.parts = {
    id: "unique-sequence-id",
    index: 0,     // position in sequence
    count: 10     // total messages (if known)
};
```

**Core sequence nodes**: Split, Join, Sort, Batch.

---

## Writing Functions (Function Node)

### Basics

The Function node body is the function body. Return `msg` to send, `null` to stop the flow.

```js
// Simple pass-through
return msg;

// Transform
msg.payload = msg.payload.toLowerCase();
return msg;

// Stop the flow
return null;
```

### Multiple Outputs

```js
// Route by topic
if (msg.topic === "alert") {
    return [null, msg];  // send to output 2 only
}
return [msg, null];      // send to output 1 only
```

### Multiple Messages on One Output

```js
var msgs = msg.payload.split(" ").map(w => ({ payload: w }));
return [msgs];
```

### Asynchronous Sending

```js
doAsync(msg, function(result) {
    msg.payload = result;
    node.send(msg);
    node.done();   // signal completion (Node-RED 1.0+)
});
return;  // MUST return without a message
```

### `node.send()` Cloning Behaviour

- `node.send(msg)` — clones the message by default.
- `node.send(msg, false)` — skip cloning (performance, or non-cloneable data).

### On Start / On Stop Tabs

```js
// On Start (Setup) — since Node-RED 1.1.0
// Initialise context, return a Promise for async setup
if (context.get("counter") === undefined) {
    context.set("counter", 0);
}

// On Stop (Close) — since Node-RED 1.1.0
// Cleanup code, equivalent to node.on('close', ...)
```

### Function Node API Reference

| Object | Methods |
|--------|---------|
| `node` | `.id`, `.name`, `.outputCount`, `.log()`, `.warn()`, `.error()`, `.debug()`, `.trace()`, `.on()`, `.status()`, `.send()`, `.done()` |
| `context` | `.get()`, `.set()`, `.keys()`, `.flow`, `.global` |
| `flow` | `.get()`, `.set()`, `.keys()` |
| `global` | `.get()`, `.set()`, `.keys()` |
| `RED` | `.util.cloneMessage()` |
| `env` | `.get("ENV_VAR")` |

### Available Modules

`Buffer`, `console`, `util`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`.

Auto-cleared on deploy/stop.

### Loading External Modules

**Option 1 — `functionGlobalContext`** (settings.js):

```js
functionGlobalContext: {
    osModule: require('os')
}
// In Function: global.get('osModule')
```

**Option 2 — `functionExternalModules: true`** (since Node-RED 1.3.0):

The edit dialog provides a UI for adding npm modules. They install under `~/.node-red/node_modules/`.

### Handling Timeouts (since Node-RED 3.1)

Set on the Setup tab (seconds). `0` = no timeout.

---

## Error Handling

### Three Error Categories

| Category | Caught by Catch node? | Action |
|----------|-----------------------|--------|
| **Catchable** | Yes | `node.error(err, msg)` |
| **Uncatchable** (log only) | No | Poorly written `node.error()` without `msg` |
| **uncaughtException** | No | Runtime crash — async error without handler |

### Reporting Catchable Errors (Custom Nodes)

```js
this.on('input', function(msg, send, done) {
    try {
        doWork(msg);
        send(msg);
        if (done) done();
    } catch(err) {
        if (done) {
            done(err);            // Node-RED 1.0+ — triggers Catch node
        } else {
            node.error(err, msg); // Node-RED 0.x — triggers Catch node
        }
    }
});
```

**CRITICAL**: Always pass `msg` as the second argument to `node.error()` — without it, the Catch node won't trigger.

### Catch Node — `msg.error` Structure

```js
{
    "error": {
        "message": "An error",
        "source": {
            "id": "node-id",
            "type": "node-type",
            "name": "Node Name",
            "count": 1         // loop detection counter (max 9 before forced break)
        }
    }
}
```

Previous `msg.error` is preserved as `msg._error`.

### Error Handling in Subflows

Error propagates: Catch nodes inside subflow checked first → then error bubbles to containing flow.

### Handling Status Changes

```js
// Status node catches status events (e.g., connect/disconnect)
// msg.status structure:
{
    "status": {
        "fill": "red",
        "shape": "ring",
        "text": "disconnected",
        "source": { "id": "node-id", "type": "mqtt out" }
    }
}
```

---

## Environment Variables

### In Node Properties

Set any property to `${ENV_VAR}` to substitute at deploy time. Must replace the **entire** value — partial substitution is not supported (e.g., `CLIENT-${HOST}` won't work).

### In TypedInput Widget

Select "environment variable" type. Supports `${VAR}` interpolation within the value.

### In JSONata Expressions

```js
$env('MY_VAR')
```

### In Function Nodes

```js
let val = env.get("MY_VAR");
```

### In Template Nodes (since Node-RED 3.0)

```mustache
My value is {{env.MY_VAR}}.
```

### Built-In Environment Variables (since Node-RED 2.2)

| Variable | Description |
|----------|-------------|
| `NR_NODE_ID` | ID of the node |
| `NR_NODE_NAME` | Name of the node |
| `NR_NODE_PATH` | `/`-delimited path of flow/subflow IDs + node ID |
| `NR_GROUP_ID` | ID of containing group |
| `NR_GROUP_NAME` | Name of containing group |
| `NR_FLOW_ID` | ID of the flow |
| `NR_FLOW_NAME` | Name of the flow |
| `NR_SUBFLOW_NAME` | Name of containing subflow instance (since 3.1) |
| `NR_SUBFLOW_ID` | ID of containing subflow instance (since 3.1) |
| `NR_SUBFLOW_PATH` | Path of containing subflow instance (since 3.1) |

### Flow/Group/Global Environment Variables

- **Flow-level**: Set in the Flow edit dialog (since 2.1).
- **Group-level**: Set in the Group edit dialog (since 2.1).
- **Global-level**: Set in User Settings (since 3.1).

### Accessing Nested Environment Variables

Prefix with `$parent.` to access the enclosing scope's variables from within a subflow.

### Running as a Service

Add `process.env.MY_VAR = 'value';` **outside** the `module.exports` block in settings.js, or use an `environment` file in `~/.node-red/`.

---

## Internationalisation (i18n)

### Directory Structure

```
myNode/
  locales/
    en-US/
      my-node.json      ← message catalog
      my-node.html      ← translated help text
    de/
      my-node.json
      my-node.html
  my-node.js
  my-node.html
```

The `locales/` directory must be alongside the `.js` file. Default language: `en-US`.

### Message Catalog Format

```json
{
    "myNode": {
        "label": {
            "name": "Name",
            "server": "Server"
        },
        "status": {
            "connected": "connected",
            "disconnected": "disconnected"
        },
        "errors": {
            "missingConfig": "Missing configuration"
        }
    }
}
```

Namespace: `<module-name>/<node-type>` (e.g., `my-module/myNode`).

### Using i18n in Runtime

```js
RED._("myNode.errors.missingConfig");
```

### Using i18n in Editor

```html
<span data-i18n="myNode.label.name"></span>
<input type="text" data-i18n="[placeholder]myNode.label.namePlaceholder">
<a href="#" data-i18n="[title]myNode.label.linkTitle;myNode.label.linkText"></a>
```

In definition functions (e.g., `oneditprepare`):

```js
this._("myNode.label.name");
```

### i18n Status Messages

```js
this.status({ fill: "green", shape: "dot", text: "myNode.status.connected" });
// Use core statuses with namespace:
this.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" });
```

---

## Help Text Style Guide

### Structure

1. **First `<p>`**: Overview (2-3 lines max). Used as palette tooltip.
2. **Inputs** (`<h3>Inputs</h3>`): `<dl class="message-properties">` list.
3. **Outputs** (`<h3>Outputs</h3>`): Same format. For multiple outputs, wrap in `<ol class="node-ports">`.
4. **Details** (`<h3>Details</h3>`): Extended explanation.
5. **References** (`<h3>References</h3>`): Links to external docs, GitHub, etc.

### Message Properties Markup

```html
<dl class="message-properties">
    <dt>payload <span class="property-type">string | buffer</span></dt>
    <dd>the payload description.</dd>
    <dt class="optional">topic <span class="property-type">string</span></dt>
    <dd>optional topic.</dd>
</dl>
```

### Multiple Outputs

```html
<ol class="node-ports">
    <li>Standard output
        <dl class="message-properties">
            <dt>payload <span class="property-type">string</span></dt>
            <dd>the standard output.</dd>
        </dl>
    </li>
    <li>Error output
        <dl class="message-properties">
            <dt>payload <span class="property-type">string</span></dt>
            <dd>the error message.</dd>
        </dl>
    </li>
</ol>
```

### General Rules

- Section headers: `<h3>`. Sub-sections: `<h4>`.
- Message properties outside property lists: prefix with `msg.` in `<code>` tags.
- No `<b>`, `<i>`, or other styling within help body.
- Be helpful. Don't assume developer expertise or domain knowledge.

---

## Adding Example Flows

Place JSON flow files in an `examples/` directory at the package root.

```
├── examples/
│   ├── Basic Example.json
│   └── Advanced Usage.json
├── package.json
└── ...
```

- Filename becomes the menu entry (minus `.json`).
- Keep examples short, with a **Comment node** explaining functionality.
- Avoid dependencies on 3rd-party nodes.

---

## Loading Extra Editor Resources

Since Node-RED 1.3, a `resources/` directory at the module root is served at `/resources/<module-name>/`.

```
node-red-node-example/
  resources/
    image.png
    library.js
  example-node.js
  example-node.html
  package.json
```

### Loading in the Editor

Use **relative URLs** (no leading `/`):

```html
<img src="resources/node-red-node-example/image.png" />
<script src="resources/node-red-node-example/library.js"></script>
```

For scoped modules: `resources/@scope/node-red-contrib-example/file.js`.

---

## Packaging & Publishing

### Naming (since January 2022)

- **Scoped names required**: `@myScope/node-red-sample` or `@myScope/sample`.
- Having `node-red` in the name aids discoverability.
- Forking: keep original name, release under your own scope.

### Directory Structure

```
├── LICENSE
├── README.md
├── package.json
├── examples/
│   ├── example-1.json
│   └── example-2.json
└── nodes/
    ├── icons/
    │   └── my-icon.svg
    ├── sample.html
    └── sample.js
```

No strict structure required — multiple nodes can share a directory or each have their own.

### Testing Locally

```bash
cd ~/.node-red
npm install <path-to-your-module>
# Creates a symlink — restart Node-RED to pick up changes
```

### Publishing to npm

Standard `npm publish` workflow. Add `"node-red"` to `keywords` only when ready.

### Adding to flows.nodered.org

Since April 2020, manual submission is required — automatic indexing from npm is no longer supported. Use the `+` button on https://flows.nodered.org/ to submit.

---

## Subflow Modules

Since Node-RED 1.3 (experimental).

Subflows can be packaged as npm modules. When installed, they appear as regular palette nodes — users cannot see/modify the internal flow.

### Creating the Module

1. Create directory and `npm init`.
2. Create `subflow.json` — export from editor, restructure JSON.
3. Create JS wrapper:

```js
const fs = require("fs");
const path = require("path");

module.exports = function(RED) {
    const subflowFile = path.join(__dirname, "subflow.json");
    const subflowContents = fs.readFileSync(subflowFile);
    const subflowJSON = JSON.parse(subflowContents);
    RED.nodes.registerSubflow(subflowJSON);
};
```

4. Update `package.json` with `node-red.nodes` entry.
5. Add any non-default node dependencies to both `dependencies` and `node-red.dependencies`.

### subflow.json Structure

```json
{
    "id": "Subflow Definition Node",
    "type": "subflow",
    "name": "My Subflow",
    "flow": [
        { "id": "Node 1", "type": "...", ... },
        { "id": "Node 2", "type": "...", ... }
    ]
}
```

---

## Unit Testing with node-red-node-test-helper

The [`node-red-node-test-helper`](https://www.npmjs.com/package/node-red-node-test-helper) framework wraps the Node-RED runtime for testing.

### Basic Test File

```js
var helper = require("node-red-node-test-helper");
var myNode = require("../my-node.js");

describe('my-node Node', function () {

    afterEach(function () {
        helper.unload();
    });

    it('should be loaded', function (done) {
        var flow = [{ id: "n1", type: "my-node", name: "test name" }];
        helper.load(myNode, flow, function () {
            var n1 = helper.getNode("n1");
            n1.should.have.property('name', 'test name');
            done();
        });
    });

    it('should process payload', function (done) {
        var flow = [
            { id: "n1", type: "my-node", name: "test", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(myNode, flow, function () {
            var n2 = helper.getNode("n2");
            var n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                msg.should.have.property('payload', 'expected-value');
                done();
            });
            n1.receive({ payload: "test-input" });
        });
    });
});
```

### Key Testing Patterns

- `helper.load(nodeModule, flowArray, callback)` — load nodes into test runtime.
- `helper.getNode(id)` — get a node instance.
- `helper.unload()` — cleanup after each test.
- Use `"helper"` as the type for test sink nodes.
- Call `n1.receive(msg)` to inject test messages.
- Listen for `"input"` on helper nodes to verify outputs.

---

## General Design Principles

From the official Node-RED guidelines — all custom nodes should follow these:

1. **Well-defined purpose**: A node should do one thing well. A group of focussed nodes is better than one overloaded node.

2. **Simple to use**: Hide complexity. Avoid jargon or requiring domain-specific knowledge.

3. **Forgiving with input types**: `msg.payload` can be String, Number, Boolean, Buffer, Object, Array, or null. Handle them all gracefully.

4. **Consistent output**: Document exactly which properties the node sets on outgoing messages. Be predictable.

5. **One role per node**: Sit at the beginning, middle, OR end of a flow — not all at once.

6. **Catch all errors**: An uncaught error crashes the **entire** Node-RED runtime. Always wrap async operations in error handlers. Always register error callbacks.

7. **Proper error reporting**: Use `done(err)` (Node-RED 1.0+) or `node.error(err, msg)` to report errors so the Catch node can handle them.

8. **Status updates**: Use `this.status()` to communicate node state (connected, disconnected, processing) to the editor.

9. **Graceful cleanup**: Register `close` event handlers for async shutdown, disconnection, and resource release.

10. **Backwards compatibility**: Check for `send` and `done` function existence to support both Node-RED 0.x and 1.0+.
