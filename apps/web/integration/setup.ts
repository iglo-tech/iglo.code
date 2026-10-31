// Base UI effects read the bare `document` global, which is undeclared in this node harness.
Object.assign(globalThis, { document: undefined });
