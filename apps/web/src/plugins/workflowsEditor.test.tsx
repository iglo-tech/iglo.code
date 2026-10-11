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
import { create, type ReactTestRenderer } from "react-test-renderer";
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

async function open(mode: "save" | "replace") {
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
    read: vi.fn(async () => entry(mode === "save" ? original : null)),
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
  if (mode === "replace") {
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
    button(label).props.onClick();
  });
}
async function rename(title: string) {
  await act(async () => {
    input("wf-workflow-title").props.onChange({ currentTarget: { value: title } });
  });
}

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
    await click("End: End 1");
    // Capture stale handlers while editable: the freeze must hold even before React rerenders.
    const add = button("End").props.onClick;
    const route = renderer!.root
      .findByProps({ "aria-label": "Route list" })
      .findAllByType("li")
      .find((node) => node.props.onKeyDown !== undefined)!;
    const keys = route.props.onKeyDown;
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
