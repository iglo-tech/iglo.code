import { EnvironmentId, ProjectId } from "@t3tools/plugin-host-contract/schema";
import type {
  PluginDesign,
  PluginDraftStore,
  PluginWebContext,
} from "@t3tools/plugin-host-contract/web";
import {
  manifest,
  type AuthoringEntry,
  type Definition,
  type WorkflowClient,
} from "@t3tools/plugin-workflows/contracts";
import { web, authoringTimings, preloadWorkflowPages } from "@t3tools/plugin-workflows/web";
import * as Yaml from "yaml";
import { act, Suspense } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// Exercise the real editor and its recovery store using the public host design contract.
const design: PluginDesign = {
  Button: ({ children, onClick, disabled, ariaLabel, id }) => (
    <button id={id} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Input: ({ id, value, onChange, disabled, readOnly }) => (
    <input
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      disabled={disabled}
      readOnly={readOnly}
    />
  ),
  Textarea: ({ id, value, onChange, disabled, readOnly }) => (
    <textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      disabled={disabled}
      readOnly={readOnly}
    />
  ),
  Select: ({ id, value, onChange, disabled }) => (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
  Badge: ({ children }) => <span>{children}</span>,
  Tooltip: ({ children }) => children,
  Icon: () => null,
  Menu: ({ ariaLabel, items, disabled }) => (
    <nav aria-label={ariaLabel}>
      {items.map((item) => (
        <button key={item.label} disabled={disabled || item.disabled} onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </nav>
  ),
  SegmentedControl: ({ options, onChange }) => (
    <nav>
      {options.map((option) => (
        <button key={option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </nav>
  ),
  Alert: ({ title, children, actions }) => (
    <section aria-label={title}>
      {children}
      {actions}
    </section>
  ),
  Empty: ({ title, children }) => <section aria-label={title}>{children}</section>,
  ListGroup: ({ children }) => <section>{children}</section>,
  ListRow: ({ children }) => <div>{children}</div>,
  PageHeader: ({ children }) => <header>{children}</header>,
  Sheet: ({ open, children }) => (open ? <section>{children}</section> : null),
  Dialog: ({ open, children }) => (open ? <section>{children}</section> : null),
  ConfirmDialog: () => null,
  NavigationGuard: ({ when, onDiscard }) =>
    when ? <button onClick={onDiscard}>Discard navigation draft</button> : null,
};

const source = ".t3code/workflows/kept-name.yml";
const projectId = ProjectId.make("project");
const EditorPageView = web.pages.find((page) => page.id === "workflows.editor")!.component;
type PageProps = PluginWebContext & { readonly client: WorkflowClient };
const newDefinition = (title: string): Definition => ({
  version: 1,
  id: "original",
  revision: 1,
  title,
  entry: "done",
  atLimit: "done",
  nodes: [{ id: "done", kind: "end", title: "Done", outcome: "completed" }],
});
const yaml = (definition: Definition) => Yaml.stringify(definition);
const key = `${projectId}:${source}`;
const readDraft = (store: PluginDraftStore): unknown => JSON.parse(store.read(key) ?? "null");
const original = newDefinition("Original");
const entry = (definition: Definition | null): AuthoringEntry => ({
  source,
  fingerprint: "observed",
  definition,
  packaged: false,
  runnable: definition !== null,
  reasons: definition === null ? ["Invalid workflow YAML."] : [],
  problems: [],
  duplicate: false,
  text: definition === null ? "version: [" : yaml(definition),
  protectedValues: 0,
  lossless: true,
});
let renderer: ReactTestRenderer | null = null;
const timings = { ...authoringTimings };
beforeEach(async () => {
  await preloadWorkflowPages();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Flow's keyboard listeners need a window; refs stay null in this Node renderer.
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("cancelAnimationFrame", () => {});
  authoringTimings.draftDelayMs = 0;
  authoringTimings.validationDelayMs = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  Object.assign(authoringTimings, timings);
  vi.unstubAllGlobals();
});

function controlledEntry() {
  let resolve!: (entry: AuthoringEntry) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<AuthoringEntry>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function open(
  mode: "save" | "replace",
  options: { read?: WorkflowClient["read"]; recovered?: Definition } = {},
) {
  const response = controlledEntry();
  const values = new Map<string, string>();
  const drafts = {
    read: (key: string) => values.get(key) ?? null,
    write: (key: string, value: string) => {
      values.set(key, value);
      return true;
    },
    remove: (key: string) => {
      values.delete(key);
    },
    keys: () => [...values.keys()],
  };
  if (options.recovered !== undefined)
    drafts.write(
      key,
      JSON.stringify({
        version: 1,
        base: {
          mode: mode === "save" ? "edit" : "replace",
          source,
          fingerprint: "observed",
          revision: mode === "save" ? 1 : null,
        },
        definition: options.recovered,
        updatedAt: 1,
      }),
    );
  const client = {
    subscribePermissions: (listener) => {
      listener({ save: true, replace: true, remove: true });
      return () => {};
    },
    projects: async () => [{ id: projectId, title: "Project", location: "workspace" }],
    capabilities: async () => ({
      nodeKinds: ["agent", "end"],
      providers: [],
      discoveryError: null,
    }),
    read: vi.fn(options.read ?? (async () => entry(mode === "save" ? original : null))),
    validate: async ({ definition }) => ({
      source,
      definition,
      runnable: true,
      reasons: [],
      problems: [],
    }),
    save: vi.fn<WorkflowClient["save"]>(() => response.promise),
    replace: vi.fn<WorkflowClient["replace"]>(() => response.promise),
    library: async () => {
      throw new Error("Not requested by this editor");
    },
    remove: async () => {},
    skills: async () => [],
  } satisfies WorkflowClient;
  const props: PageProps = {
    ...design,
    client,
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    projectId,
    threadId: null,
    connection: "connected",
    pageState: { source },
    descriptor: {
      environmentId: EnvironmentId.make("environment"),
      manifest,
      status: "available",
      reason: null,
    },
    drafts,
    navigate: vi.fn(),
    notify: vi.fn(),
    openThread: vi.fn(),
  };
  await act(async () => {
    renderer = create(
      <Suspense fallback="Loading editor">
        <EditorPageView {...props} />
      </Suspense>,
    );
  });
  if (mode === "replace" && options.recovered === undefined) {
    await act(async () => {
      input("wf-import").props.onChange({ currentTarget: { value: yaml(original) } });
    });
    await click("Preview import");
    await click("Replace draft");
  }
  return { response, drafts, client, props };
}
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.children.includes(label))!;
const input = (id: string) =>
  renderer!.root.findAll((node) => typeof node.type === "string" && node.props.id === id)[0]!;
async function click(label: string) {
  await act(async () => {
    // Graph step clicks bubble to React Flow's node wrapper in the browser.
    let target: ReactTestInstance | null = button(label);
    while (target !== null && typeof target.props.onClick !== "function") target = target.parent;
    if (target === null) throw new Error(`No click handler for ${label}`);
    target.props.onClick({});
  });
}
async function rename(title: string) {
  await act(async () => {
    input("wf-workflow-title").props.onChange({ currentTarget: { value: title } });
  });
}

async function reconnect(props: PageProps) {
  await act(async () => {
    renderer!.update(
      <Suspense fallback="Loading editor">
        <EditorPageView {...props} connection="disconnected" />
      </Suspense>,
    );
  });
  await act(async () => {
    renderer!.update(
      <Suspense fallback="Loading editor">
        <EditorPageView {...props} />
      </Suspense>,
    );
  });
}

const alert = (title: string) => renderer!.root.findAllByProps({ "aria-label": title });
const savedRevision = (revision: number) =>
  renderer!.root
    .findByProps({ role: "status" })
    .findAll((node) => node.children.includes(`Saved revision ${revision}`));

it.each([false, true])(
  "authors in Graph without layout APIs and reorders at narrow=%s",
  async (narrow) => {
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        matchMedia: () => Object.assign(new EventTarget(), { matches: narrow }),
      }),
    );
    const test = await open("save");
    expect(button("Routes")).toBeUndefined();
    expect(button("End: Done")).toBeDefined();
    if (narrow) await click("Add a step");
    await click("End");
    const draft = () => readDraft(test.drafts) as { definition: Definition };
    const added = draft().definition;
    const keyDown = (label: string, key: string) =>
      act(async () => {
        button(label).props.onKeyDown({ key, altKey: true, preventDefault() {} });
      });
    await keyDown("End: Done", "ArrowUp");
    expect(draft().definition).toEqual(added);
    await keyDown("End: End 1", "ArrowUp");
    expect(draft().definition.nodes.map((node) => node.id)).toEqual(["end-1", "done"]);
    expect(draft().definition).toEqual({ ...added, nodes: added.nodes.toReversed() });
    expect(button("Move End 1 up").props.disabled).toBe(true);
    await click("Move End 1 down");
    expect(draft().definition).toEqual(added);
    expect(button("Move End 1 down").props.disabled).toBe(true);
    await keyDown("End: End 1", "ArrowDown");
    expect(draft().definition).toEqual(added);
    await keyDown("End: End 1", "ArrowUp");
    await keyDown("End: End 1", "ArrowDown");
    expect(draft().definition).toEqual(added);
    await act(async () =>
      button("End: End 1").props.onKeyDown({ key: "Delete", preventDefault() {} }),
    );
    expect(button("End: End 1")).toBeUndefined();
    expect(readDraft(test.drafts)).toBeNull();
  },
);

it.each([
  { mode: "save", start: "before", outcome: "saved" },
  { mode: "save", start: "before", outcome: "invalid" },
  { mode: "save", start: "before", outcome: "failure" },
  { mode: "save", start: "during", outcome: "saved" },
  { mode: "save", start: "during", outcome: "invalid" },
  { mode: "save", start: "during", outcome: "failure" },
  { mode: "replace", start: "before", outcome: "saved" },
  { mode: "replace", start: "before", outcome: "invalid" },
  { mode: "replace", start: "before", outcome: "failure" },
  { mode: "replace", start: "during", outcome: "saved" },
  { mode: "replace", start: "during", outcome: "invalid" },
  { mode: "replace", start: "during", outcome: "failure" },
] as const)(
  "ignores a background $outcome response begun $start a successful $mode",
  async ({ mode, start, outcome }) => {
    const read = controlledEntry();
    const test = await open(mode, {
      recovered: newDefinition("Recovered local draft"),
      ...(start === "before" ? { read: () => read.promise } : {}),
    });
    // A real initial invalid-file read opens repair. Leave that pane before saving
    // so a later obsolete response must not reopen it.
    if (mode === "replace" && start === "during") await click("Graph");
    await click(mode === "save" ? "Save" : "Validate and replace file");
    if (start === "during") {
      test.client.read.mockImplementationOnce(() => read.promise);
      await reconnect(test.props);
    }
    const submitted = test.client[mode].mock.lastCall![0].definition;
    await act(async () => {
      test.response.resolve({ ...entry(submitted), fingerprint: "saved" });
      await test.response.promise;
    });
    expect(savedRevision(submitted.revision)).toHaveLength(1);
    expect(test.drafts.keys()).toEqual([]);
    await act(async () => {
      if (outcome === "failure") read.reject({ message: "Superseded background error" });
      else {
        read.resolve(entry(outcome === "invalid" ? null : original));
        await read.promise;
      }
    });
    expect(input("wf-workflow-title").props.value).toBe("Recovered local draft");
    expect(button("Save").props.disabled).toBe(true);
    expect(savedRevision(submitted.revision)).toHaveLength(1);
    expect(test.drafts.keys()).toEqual([]);
    expect(alert("Changed on the server")).toHaveLength(0);
    expect(alert("Could not load this workflow")).toHaveLength(0);
    expect(alert("This file is not a valid workflow")).toHaveLength(0);
    expect(button("Discard navigation draft")).toBeUndefined();
    expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
    await rename("Continued after publication");
    expect(readDraft(test.drafts)).toMatchObject({
      definition: { title: "Continued after publication" },
      base: { mode: "edit", fingerprint: "saved", revision: submitted.revision },
    });
    const nextSave = controlledEntry();
    test.client.save.mockImplementationOnce(() => nextSave.promise);
    await click("Save");
    expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
      expectedRevision: submitted.revision,
      fingerprint: "saved",
      definition: { title: "Continued after publication", revision: submitted.revision + 1 },
    });
  },
);

it("ignores a Retry read begun during Save even when edits continue after publication", async () => {
  const test = await open("save", {
    recovered: newDefinition("Recovered local draft"),
    read: async () => {
      throw new Error("Initial load failed");
    },
  });
  const read = controlledEntry();
  test.client.read.mockImplementationOnce(() => read.promise);
  await click("Save");
  await click("Retry");
  const submitted = test.client.save.mock.lastCall![0].definition;
  await act(async () => {
    test.response.resolve({ ...entry(submitted), fingerprint: "saved" });
    await test.response.promise;
  });
  await rename("Edited after saving");
  const recovered = readDraft(test.drafts);
  await act(async () => {
    read.resolve(entry(original));
    await read.promise;
  });
  expect(input("wf-workflow-title").props.value).toBe("Edited after saving");
  expect(readDraft(test.drafts)).toEqual(recovered);
  expect(recovered).toMatchObject({ base: { fingerprint: "saved", revision: 2 } });
  expect(alert("Changed on the server")).toHaveLength(0);
  expect(alert("Could not load this workflow")).toHaveLength(0);
  expect(button("Save").props.disabled).toBe(false);
});

it.each(["conflict", "service"])(
  "retains edits after a %s save failure and reconciles a fresh read rather than an older error",
  async (code) => {
    const test = await open("save");
    await rename("Unsaved local draft");
    await click("Save");
    const read = controlledEntry();
    test.client.read.mockImplementationOnce(() => read.promise);
    await reconnect(test.props);
    const recovered = readDraft(test.drafts);
    await act(async () => {
      test.response.reject({ code, message: "Save did not complete" });
    });
    await act(async () => {
      read.reject({ message: "Older background error" });
    });
    expect(input("wf-workflow-title").props.value).toBe("Unsaved local draft");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Could not load this workflow")).toHaveLength(0);
    expect(
      alert(code === "conflict" ? "Changed on the server" : "Not saved · edits kept"),
    ).toHaveLength(1);
    test.client.read.mockResolvedValue({
      ...entry({ ...original, revision: 5, title: "Current remote workflow" }),
      fingerprint: "remote",
    });
    await reconnect(test.props);
    expect(input("wf-workflow-title").props.value).toBe("Unsaved local draft");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Changed on the server")).toHaveLength(1);
    await click("Compare");
    expect(input("wf-compare-draft").props.value).toContain("Unsaved local draft");
    expect(input("wf-compare-server").props.value).toContain("Current remote workflow");
  },
);

it.each(["conflict", "service"])(
  "replaces a superseded initial read after a %s save failure so recovery still gets metadata",
  async (code) => {
    const initial = controlledEntry();
    const test = await open("save", {
      recovered: newDefinition("Recovered local draft"),
      read: () => initial.promise,
    });
    const fresh = controlledEntry();
    test.client.read.mockImplementationOnce(() => fresh.promise);
    await click("Save");
    const recovered = readDraft(test.drafts);
    await act(async () => {
      test.response.reject({ code, message: "Save did not complete" });
    });
    expect(test.client.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      initial.resolve(entry(null));
      await initial.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe("Recovered local draft");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
    await act(async () => {
      fresh.resolve({ ...entry({ ...original, revision: 5 }), fingerprint: "remote" });
      await fresh.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe("Recovered local draft");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Changed on the server")).toHaveLength(1);
    expect(input("wf-workflow-title").props.disabled).toBe(false);
  },
);

it.each(["Discard changes", "Replace draft"])(
  "loads fresh metadata after %s supersedes an initial read without a server snapshot",
  async (action) => {
    const initial = controlledEntry();
    const test = await open("save", {
      recovered: newDefinition("Recovered local draft"),
      read: () => initial.promise,
    });
    const fresh = controlledEntry();
    test.client.read.mockImplementationOnce(() => fresh.promise);
    if (action === "Replace draft") {
      await click("Import YAML");
      await act(async () => {
        input("wf-import").props.onChange({
          currentTarget: { value: yaml(newDefinition("Imported draft")) },
        });
      });
      await click("Preview import");
    }
    await click(action);
    expect(test.client.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      initial.resolve(entry(null));
      await initial.promise;
    });
    expect(alert("This file is not a valid workflow")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
    await act(async () => {
      fresh.resolve({
        ...entry({ ...original, revision: 5, title: "Fresh remote workflow" }),
        fingerprint: "remote",
      });
      await fresh.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe(
      action === "Replace draft" ? "Imported draft" : "Fresh remote workflow",
    );
    if (action === "Replace draft") {
      expect(readDraft(test.drafts)).toMatchObject({
        definition: { title: "Imported draft" },
        base: { fingerprint: "observed", revision: 1 },
      });
      expect(alert("Changed on the server")).toHaveLength(1);
    } else {
      expect(savedRevision(5)).toHaveLength(1);
      expect(test.drafts.keys()).toEqual([]);
      expect(button("Save").props.disabled).toBe(true);
    }
  },
);

it.each(["invalid", "failure"])(
  "ignores a background %s response delivered while Save is still pending",
  async (outcome) => {
    const test = await open("save");
    await rename("Draft being saved");
    await click("Save");
    const read = controlledEntry();
    test.client.read.mockImplementationOnce(() => read.promise);
    await reconnect(test.props);
    await act(async () => {
      if (outcome === "failure") read.reject({ message: "Older read error" });
      else {
        read.resolve(entry(null));
        await read.promise;
      }
    });
    expect(alert("Could not load this workflow")).toHaveLength(0);
    expect(alert("This file is not a valid workflow")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
    expect(input("wf-workflow-title").props.value).toBe("Draft being saved");
    expect(input("wf-workflow-title").props.disabled).toBe(true);
    const submitted = test.client.save.mock.lastCall![0].definition;
    await act(async () => {
      test.response.resolve({ ...entry(submitted), fingerprint: "saved" });
      await test.response.promise;
    });
    expect(savedRevision(2)).toHaveLength(1);
    expect(button("Save").props.disabled).toBe(true);
    expect(test.drafts.keys()).toEqual([]);
  },
);

it.each(["Reload", "Keep my draft", "Discard changes"])(
  "ignores an older reconnect read after %s establishes the draft baseline",
  async (action) => {
    const test = await conflict();
    const background = controlledEntry();
    test.client.read.mockReset().mockImplementationOnce(() => background.promise);
    await reconnect(test.props);
    test.client.read.mockResolvedValueOnce({
      ...entry({ ...original, title: "Latest remote workflow", revision: 5 }),
      fingerprint: "remote",
    });
    await click(action);
    const title = input("wf-workflow-title").props.value;
    const recovered = readDraft(test.drafts);
    await act(async () => {
      background.resolve(entry(null));
      await background.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe(title);
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Changed on the server")).toHaveLength(0);
    expect(alert("This file is not a valid workflow")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
    if (action === "Keep my draft")
      expect(recovered).toMatchObject({ base: { fingerprint: "remote", revision: 5 } });
    else expect(button("Save").props.disabled).toBe(true);
  },
);

it("keeps an adopted YAML draft when an older background read returns an invalid file", async () => {
  const test = await open("save");
  const read = controlledEntry();
  test.client.read.mockImplementationOnce(() => read.promise);
  await reconnect(test.props);
  await click("Import YAML");
  await act(async () => {
    input("wf-import").props.onChange({
      currentTarget: { value: yaml(newDefinition("Imported draft")) },
    });
  });
  await click("Preview import");
  await click("Replace draft");
  const recovered = readDraft(test.drafts);
  await act(async () => {
    read.resolve(entry(null));
    await read.promise;
  });
  expect(input("wf-workflow-title").props.value).toBe("Imported draft");
  expect(readDraft(test.drafts)).toEqual(recovered);
  expect(alert("This file is not a valid workflow")).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ id: "wf-import" })).toHaveLength(0);
  expect(button("Save").props.disabled).toBe(false);
});

it.each(["initial", "reconnect"])(
  "reconciles an ordinary %s read during typing without losing edits or the recovery base",
  async (start) => {
    const read = controlledEntry();
    const test = await open("save", {
      recovered: newDefinition("Recovered draft"),
      ...(start === "initial" ? { read: () => read.promise } : {}),
    });
    if (start === "reconnect") {
      test.client.read.mockImplementationOnce(() => read.promise);
      await reconnect(test.props);
    }
    await rename("Typed while reading");
    const recovered = readDraft(test.drafts);
    await act(async () => {
      read.resolve({ ...entry({ ...original, revision: 5 }), fingerprint: "remote" });
      await read.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe("Typed while reading");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Changed on the server")).toHaveLength(1);
    expect(button("Save").props.disabled).toBe(false);
    await click("Save");
    expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
      expectedRevision: 1,
      fingerprint: "observed",
      definition: { title: "Typed while reading", revision: 2 },
    });
  },
);

it("adopts packaged identity from an ordinary initial read even when the recovered draft was edited", async () => {
  const read = controlledEntry();
  const test = await open("save", {
    recovered: newDefinition("Recovered packaged draft"),
    read: () => read.promise,
  });
  await rename("Typed before packaged metadata arrived");
  await act(async () => {
    read.resolve({ ...entry(original), packaged: true });
    await read.promise;
  });
  expect(input("wf-workflow-title").props.value).toBe("Typed before packaged metadata arrived");
  expect(input("wf-workflow-title").props.disabled).toBe(true);
  expect(button("Save")).toBeUndefined();
  expect(button("Clone to edit").props.disabled).toBe(false);
  expect(test.client.save).not.toHaveBeenCalled();
});

it.each(["invalid", "failure"])(
  "ignores an unmounted background %s response after recovery and continued editing",
  async (outcome) => {
    const read = controlledEntry();
    const test = await open("save", {
      recovered: newDefinition("Recovered draft"),
      read: () => read.promise,
    });
    await act(async () => renderer!.unmount());
    test.client.read.mockResolvedValueOnce(entry(original));
    await act(async () => {
      renderer = create(
        <Suspense fallback="Loading editor">
          <EditorPageView {...test.props} />
        </Suspense>,
      );
    });
    await rename("Continued in reopened editor");
    const recovered = readDraft(test.drafts);
    await act(async () => {
      if (outcome === "failure") read.reject({ message: "Unmounted read error" });
      else {
        read.resolve(entry(null));
        await read.promise;
      }
    });
    expect(input("wf-workflow-title").props.value).toBe("Continued in reopened editor");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(alert("Could not load this workflow")).toHaveLength(0);
    expect(alert("This file is not a valid workflow")).toHaveLength(0);
    expect(button("Save").props.disabled).toBe(false);
  },
);

async function conflict(action = "Reload") {
  const test = await open("save");
  await rename("Conflicting draft");
  await click("Save");
  await act(async () => {
    test.response.reject({ code: "conflict", message: "The workflow revision changed." });
  });
  const read = controlledEntry();
  test.client.read.mockImplementationOnce(() => read.promise);
  const start = () => click(action);
  return { ...test, read, start };
}

it("keeps edits and their recovery base when a pending Reload is superseded by typing", async () => {
  const test = await conflict();
  const reload = button("Reload").props.onClick;
  const type = input("wf-workflow-title").props.onChange;
  // Both callbacks were captured before the request, and run before React can render again.
  await act(async () => {
    reload();
    type({ currentTarget: { value: "Typed while reloading" } });
  });
  expect(input("wf-workflow-title").props.value).toBe("Typed while reloading");
  const recovered = readDraft(test.drafts);
  expect(recovered).toMatchObject({
    definition: { title: "Typed while reloading" },
    base: { source, fingerprint: "observed", revision: 1 },
  });
  await act(async () => {
    test.read.resolve({
      ...entry({ ...original, title: "Remote version", revision: 5 }),
      fingerprint: "remote",
    });
    await test.read.promise;
  });
  expect(input("wf-workflow-title").props.value).toBe("Typed while reloading");
  expect(readDraft(test.drafts)).toEqual(recovered);
  expect(button("Save").props.disabled).toBe(false);
  const saved = controlledEntry();
  test.client.save.mockImplementationOnce(() => saved.promise);
  await click("Save");
  expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
    expectedRevision: 1,
    fingerprint: "observed",
    definition: { title: "Typed while reloading", revision: 2 },
  });
});

it.each([
  { action: "Reload", continuedEditing: false },
  { action: "Reload", continuedEditing: true },
  { action: "Keep my draft", continuedEditing: false },
  { action: "Keep my draft", continuedEditing: true },
])(
  "ignores a late $action after a subsequent save completes (continued editing: $continuedEditing)",
  async ({ action, continuedEditing }) => {
    const test = await conflict(action);
    await test.start();
    const saved = controlledEntry();
    test.client.save.mockImplementationOnce(() => saved.promise);
    await click("Save");
    const submitted = test.client.save.mock.lastCall![0].definition;
    await act(async () => {
      saved.resolve({ ...entry(submitted), fingerprint: "saved" });
      await saved.promise;
    });
    expect(test.drafts.keys()).toEqual([]);
    if (continuedEditing) await rename("Continued after successful save");
    const recovered = readDraft(test.drafts);
    if (continuedEditing)
      expect(recovered).toMatchObject({
        definition: { title: "Continued after successful save" },
        base: { source, fingerprint: "saved", revision: 2 },
      });
    await act(async () => {
      test.read.resolve({
        ...entry({ ...original, title: "Remote before the later save", revision: 5 }),
        fingerprint: "remote",
      });
      await test.read.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe(
      continuedEditing ? "Continued after successful save" : "Conflicting draft",
    );
    expect(readDraft(test.drafts)).toEqual(recovered);
    if (!continuedEditing) {
      expect(
        renderer!.root
          .findByProps({ role: "status" })
          .findAll((node) => node.children.includes("Saved revision 2")),
      ).toHaveLength(1);
      await rename("Continued after successful save");
    }
    const nextSave = controlledEntry();
    test.client.save.mockImplementationOnce(() => nextSave.promise);
    await click("Save");
    expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
      expectedRevision: 2,
      fingerprint: "saved",
      definition: { title: "Continued after successful save", revision: 3 },
    });
  },
);

it("ignores a late Reload failure after a subsequent save completes", async () => {
  const test = await conflict();
  await test.start();
  const saved = controlledEntry();
  test.client.save.mockImplementationOnce(() => saved.promise);
  await click("Save");
  const submitted = test.client.save.mock.lastCall![0].definition;
  await act(async () => {
    saved.resolve({ ...entry(submitted), fingerprint: "saved" });
    await saved.promise;
  });
  await act(async () => {
    test.read.reject({ code: "service", message: "Superseded reload error" });
  });
  expect(input("wf-workflow-title").props.value).toBe("Conflicting draft");
  expect(test.drafts.keys()).toEqual([]);
  expect(button("Save").props.disabled).toBe(true);
  expect(renderer!.root.findAllByProps({ "aria-label": "Not saved · edits kept" })).toHaveLength(0);
  expect(
    renderer!.root
      .findByProps({ role: "status" })
      .findAll((node) => node.children.includes("Saved revision 2")),
  ).toHaveLength(1);
});

it("loads an unsuperseded Reload and saves later edits against its revision and fingerprint", async () => {
  const test = await conflict();
  await test.start();
  await act(async () => {
    test.read.resolve({
      ...entry({ ...original, title: "Latest server workflow", revision: 5 }),
      fingerprint: "remote",
    });
    await test.read.promise;
  });
  expect(input("wf-workflow-title").props.value).toBe("Latest server workflow");
  expect(input("wf-workflow-title").props.disabled).toBe(false);
  expect(test.drafts.keys()).toEqual([]);
  expect(button("Save").props.disabled).toBe(true);
  await rename("Edited latest version");
  expect(readDraft(test.drafts)).toMatchObject({
    definition: { title: "Edited latest version" },
    base: { source, fingerprint: "remote", revision: 5 },
  });
  const saved = controlledEntry();
  test.client.save.mockImplementationOnce(() => saved.promise);
  await click("Save");
  expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
    expectedRevision: 5,
    fingerprint: "remote",
    definition: { title: "Edited latest version", revision: 6 },
  });
});

it("retains the draft and old save base after Reload fails, including after reopening", async () => {
  const test = await conflict();
  const recovered = readDraft(test.drafts);
  await test.start();
  await act(async () => {
    test.read.reject({ code: "service", message: "Reload request failed" });
  });
  expect(input("wf-workflow-title").props.disabled).toBe(false);
  expect(input("wf-workflow-title").props.value).toBe("Conflicting draft");
  expect(readDraft(test.drafts)).toEqual(recovered);
  expect(renderer!.root.findByProps({ "aria-label": "Not saved · edits kept" }).children).toContain(
    "Reload request failed",
  );
  await act(async () => {
    renderer!.unmount();
    renderer = create(
      <Suspense fallback="Loading editor">
        <EditorPageView {...test.props} />
      </Suspense>,
    );
  });
  await rename("Continued after failed Reload");
  expect(readDraft(test.drafts)).toMatchObject({
    definition: { title: "Continued after failed Reload" },
    base: { source, fingerprint: "observed", revision: 1 },
  });
  const saved = controlledEntry();
  test.client.save.mockImplementationOnce(() => saved.promise);
  await click("Save");
  expect(test.client.save.mock.lastCall?.[0]).toMatchObject({
    expectedRevision: 1,
    fingerprint: "observed",
    definition: { title: "Continued after failed Reload", revision: 2 },
  });
});

it.each(["success", "failure"])(
  "ignores an unmounted Reload %s after recovering and continuing edits",
  async (outcome) => {
    const test = await conflict();
    await test.start();
    await rename("Draft kept before leaving");
    await act(async () => {
      renderer!.unmount();
    });
    await act(async () => {
      renderer = create(
        <Suspense fallback="Loading editor">
          <EditorPageView {...test.props} />
        </Suspense>,
      );
    });
    expect(input("wf-workflow-title").props.value).toBe("Draft kept before leaving");
    await rename("Recovered and continued after Reload");
    const recovered = readDraft(test.drafts);
    await act(async () => {
      if (outcome === "success") {
        test.read.resolve({ ...entry(newDefinition("Late remote version")), fingerprint: "late" });
        await test.read.promise;
      } else {
        test.read.reject({ code: "service", message: "Late reload error" });
      }
    });
    expect(input("wf-workflow-title").props.value).toBe("Recovered and continued after Reload");
    expect(readDraft(test.drafts)).toEqual(recovered);
    expect(button("Save").props.disabled).toBe(false);
    expect(renderer!.root.findAllByProps({ "aria-label": "Not saved · edits kept" })).toHaveLength(
      0,
    );
  },
);

it.each(["save", "replace"] as const)(
  "freezes every draft mutation until %s settles",
  async (mode) => {
    const test = await open(mode);
    await rename("First edit");
    await click("End");
    // Selecting a graph node keeps it selected; the blank pane returns to workflow settings.
    await act(async () => {
      renderer!.root
        .find(
          (node) =>
            node.type === "div" && node.props.className?.split(" ").includes("react-flow__pane"),
        )
        .props.onClick({ target: null });
    });
    // Capture stale handlers while editable: the freeze must hold even before React rerenders.
    const add = button("End").props.onClick;
    const keys = button("End: Done").props.onKeyDown;
    const discard = mode === "save" ? button("Discard changes").props.onClick : null;
    await click("Import YAML");
    await act(async () => {
      input("wf-import").props.onChange({
        currentTarget: { value: yaml(newDefinition("Imported")) },
      });
    });
    await click("Preview import");
    const adopt = button("Replace draft").props.onClick;
    const submit = button(mode === "save" ? "Save" : "Validate and replace file").props.onClick;
    // Double submit and authoring callbacks happen in the same React batch.
    await act(async () => {
      submit();
      submit();
      add();
      keys({ key: "ArrowDown", altKey: true, preventDefault() {} });
      keys({ key: "Delete", preventDefault() {} });
      discard?.();
      adopt();
    });
    await rename("Second edit while saving");
    expect(input("wf-workflow-title").props.value).toBe("First edit");
    expect(input("wf-workflow-title").props.disabled).toBe(true);
    expect(input("wf-import").props.disabled).toBe(true);
    const request = test.client[mode];
    expect(request).toHaveBeenCalledTimes(1);
    const submitted = request.mock.calls[0]![0].definition;
    expect(submitted.title).toBe("First edit");
    expect(submitted.nodes).toHaveLength(2);
    if (mode === "replace")
      expect(request.mock.calls[0]![0]).toMatchObject({
        source,
        fingerprint: "observed",
        projectId,
      });
    expect(readDraft(test.drafts)).toMatchObject({ definition: { title: "First edit" } });
    expect((readDraft(test.drafts) as { definition: Definition }).definition.nodes).toEqual(
      submitted.nodes,
    );
    await click("Discard navigation draft");
    expect(readDraft(test.drafts)).toMatchObject({ definition: { title: "First edit" } });
    await act(async () => {
      test.response.resolve({ ...entry(submitted), fingerprint: "saved" });
      await test.response.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe("First edit");
    expect(input("wf-workflow-title").props.disabled).toBe(false);
    expect(test.drafts.keys()).toEqual([]);
    expect(button("Save").props.disabled).toBe(true);
    await rename("Next edit after saving");
    expect(readDraft(test.drafts)).toMatchObject({
      definition: { title: "Next edit after saving" },
      base: { source, fingerprint: "saved", revision: submitted.revision },
    });
  },
);

it.each([
  ["save", "conflict"],
  ["replace", "conflict"],
  ["save", "service"],
  ["replace", "service"],
] as const)("retains a recoverable draft after %s rejects with %s", async (mode, code) => {
  const test = await open(mode);
  await rename("Retained draft");
  await click(mode === "save" ? "Save" : "Validate and replace file");
  await act(async () => {
    test.response.reject({ code, message: "Request failed" });
  });
  expect(input("wf-workflow-title").props.disabled).toBe(false);
  await rename("Continued after conflict");
  const recovered = readDraft(test.drafts);
  expect(recovered).toMatchObject({
    definition: { title: "Continued after conflict" },
    base: { mode: mode === "save" ? "edit" : "replace", source, fingerprint: "observed" },
  });
  await act(async () => {
    renderer!.unmount();
    renderer = create(
      <Suspense fallback="Loading editor">
        <EditorPageView {...test.props} />
      </Suspense>,
    );
  });
  expect(input("wf-workflow-title").props.value).toBe("Continued after conflict");
});

it.each(["save", "replace"] as const)(
  "keeps the displayed draft when %s succeeds",
  async (mode) => {
    const test = await open(mode);
    await rename("First edit");
    await click(mode === "save" ? "Save" : "Validate and replace file");
    // A user can type only when the control is editable. Before the fix this edit was
    // accepted, displayed and persisted, then silently overwritten by the response.
    if (!input("wf-workflow-title").props.disabled) await rename("Second edit while saving");
    const displayed = input("wf-workflow-title").props.value;
    const submitted = test.client[mode].mock.calls[0]![0].definition;
    await act(async () => {
      test.response.resolve(entry(submitted));
      await test.response.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe(displayed);
  },
);

it.each(["save", "replace"] as const)(
  "ignores a late %s response after leaving and recovering edits",
  async (mode) => {
    const test = await open(mode);
    await rename("Submitted draft");
    await click(mode === "save" ? "Save" : "Validate and replace file");
    const submitted = test.client[mode].mock.calls[0]![0].definition;
    await act(async () => {
      renderer!.unmount();
    });
    await act(async () => {
      renderer = create(
        <Suspense fallback="Loading editor">
          <EditorPageView {...test.props} />
        </Suspense>,
      );
    });
    await rename("Recovered and continued");
    await act(async () => {
      test.response.resolve(entry(submitted));
      await test.response.promise;
    });
    expect(input("wf-workflow-title").props.value).toBe("Recovered and continued");
    expect(readDraft(test.drafts)).toMatchObject({
      definition: { title: "Recovered and continued" },
    });
  },
);
