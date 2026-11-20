import { initializeI18n } from "../src/i18n/initializeI18n";

// Base UI effects read the bare `document` global, which is undeclared in this node harness.
Object.assign(globalThis, { document: undefined });

// The app initializes GT at startup; components using its hooks need the same here.
initializeI18n(() => {});
