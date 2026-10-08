import { Host } from "@t3tools/plugin-host-contract/server";
import {
  PluginError,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/plugin-host-contract/schema";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Yaml from "yaml";
import {
  Definition,
  limits,
  type AuthoringEntry,
  type Capabilities,
  type CatalogEntry,
  type LibraryEntry,
  type LibraryInput,
  type LibraryPage,
  type Problem,
  type ProjectSummary,
  type ReadInput,
  type ReplaceInput,
  type SaveInput,
  type ScopeInput,
  type Skill,
} from "./contracts.ts";
import { agentLocations, definitionDiagnostics } from "./definition.ts";
import { digest, error, protect } from "./encoding.ts";
import { examples } from "./examples.ts";
import { protectDefinition, protectParsed, restoreDefinition } from "./authoring.ts";
import * as Display from "./display.ts";

const isPluginError = Schema.is(PluginError);
export const location = ".t3code/workflows";
const decode = Schema.decodeUnknownEffect(Definition);
const sizeReason = `Workflow YAML exceeds ${limits.definitionBytes / 1024} KiB.`;
const duplicateReason = "This workflow identity is duplicated in the project catalog.";
const nodeKinds = ["agent", "check", "decision", "parallel", "join", "human", "end"] as const;
type Scope = typeof ScopeInput.Type;

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly validate: (
      scope: Scope,
      definition: Definition,
    ) => Effect.Effect<CatalogEntry, PluginError>;
    readonly list: (input: Scope) => Effect.Effect<ReadonlyArray<CatalogEntry>, PluginError>;
    readonly library: (input: LibraryInput) => Effect.Effect<LibraryPage, PluginError>;
    readonly read: (input: ReadInput) => Effect.Effect<AuthoringEntry, PluginError>;
    readonly save: (input: SaveInput) => Effect.Effect<AuthoringEntry, PluginError>;
    readonly replace: (input: ReplaceInput) => Effect.Effect<AuthoringEntry, PluginError>;
    readonly capabilities: (input: Scope) => Effect.Effect<Capabilities, PluginError>;
    readonly skills: (
      input: Scope & { readonly providerInstanceId: ProviderInstanceId },
    ) => Effect.Effect<ReadonlyArray<Skill>, PluginError>;
    readonly projects: (input: {
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<ReadonlyArray<ProjectSummary>, PluginError>;
    /** Resolve an authored snapshot for execution without applying public redaction. */
    readonly resolve: (
      input: Scope,
      definitionId: string,
    ) => Effect.Effect<CatalogEntry | undefined, PluginError>;
  }
>()("@t3tools/plugin-workflows/Catalog") {}

/** One catalog source as discovered on disk; validation against providers happens later. */
interface Scanned {
  readonly source: string;
  readonly packaged: boolean;
  readonly fingerprint: string;
  readonly contents: string | null;
  /** Parsed YAML of a schema-invalid file, kept so repair can preserve protected text. */
  readonly parsed: unknown;
  readonly definition: Definition | null;
  readonly reason: string | null;
  readonly duplicate: boolean;
}

const make = Effect.gen(function* () {
  const host = yield* Host;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: unknown) => digest(value).pipe(Effect.provideService(Crypto.Crypto, crypto));
  const lock = yield* Semaphore.make(1);
  const environment = (environmentId: EnvironmentId, operation: string) =>
    environmentId === host.environmentId
      ? Effect.void
      : Effect.fail(
          error(operation, "The requested environment is not this server.", "unavailable"),
        );
  const root = Effect.fnUntraced(function* (input: Scope) {
    yield* environment(input.environmentId, "catalog");
    const project = (yield* host.projects()).find((project) => project.id === input.projectId);
    if (!project) return yield* error("catalog", "The project is unavailable.", "unavailable");
    return path.join(project.workspaceRoot, location);
  });
  /** Provider and skill discovery shared by every definition validated in one request. */
  const discovery = Effect.fnUntraced(function* (projectId: ProjectId) {
    const providers = yield* Effect.cached(host.providers().pipe(Effect.result));
    const cache = new Map<ProviderInstanceId, Effect.Effect<SkillsResult>>();
    type SkillsResult = Effect.Success<ReturnType<typeof skillsOf>>;
    const skillsOf = (providerInstanceId: ProviderInstanceId) =>
      host.skills({ projectId, providerInstanceId }).pipe(Effect.result);
    return {
      providers,
      skills: (instanceId: ProviderInstanceId) =>
        Effect.gen(function* () {
          const cached = cache.get(instanceId);
          if (cached) return yield* cached;
          const created = yield* Effect.cached(skillsOf(instanceId));
          cache.set(instanceId, created);
          return yield* created;
        }),
    };
  });
  type Discovery = Effect.Success<ReturnType<typeof discovery>>;
  const validate = Effect.fn("Workflows.validate")(function* (
    scope: Scope,
    input: Definition,
    shared?: Discovery,
  ) {
    yield* root(scope);
    const definition = yield* decode(input).pipe(
      Effect.mapError((cause) =>
        error("validate", "Invalid workflow schema.", "validation", cause),
      ),
    );
    const problems: Problem[] = definitionDiagnostics(definition);
    if (new TextEncoder().encode(Yaml.stringify(definition)).byteLength > limits.definitionBytes)
      problems.push({ severity: "error", message: sizeReason });
    const found = shared ?? (yield* discovery(scope.projectId));
    const discovered = yield* found.providers;
    const providers = discovered._tag === "Success" ? discovered.success : [];
    if (discovered._tag === "Failure")
      problems.push({
        severity: "error",
        message: `Provider discovery is unavailable: ${discovered.failure.message}`,
      });
    for (const { nodeId, prefix, agent } of agentLocations(definition)) {
      const provider = providers.find(
        (provider) => provider.instanceId === agent.modelSelection.instanceId,
      );
      if (
        !provider?.toolsSupported ||
        provider.available !== true ||
        !provider.runtimeModes.includes(agent.runtimeMode)
      )
        problems.push({
          severity: "error",
          message: `Provider ${agent.modelSelection.instanceId} cannot report in ${agent.runtimeMode}: ${provider?.reason ?? "unavailable"}.`,
          nodeId,
          control:
            provider?.toolsSupported && provider.available === true
              ? `${prefix}runtimeMode`
              : `${prefix}modelSelection`,
        });
      if (agent.skill && provider) {
        const skills = yield* found.skills(agent.modelSelection.instanceId);
        if (skills._tag === "Failure")
          problems.push({
            severity: "error",
            message: `Skill discovery is unavailable: ${skills.failure.message}`,
            nodeId,
            control: `${prefix}skill`,
          });
        else if (!skills.success.some((skill) => skill.name === agent.skill && skill.enabled))
          problems.push({
            severity: "error",
            message: `Skill ${agent.skill} is unavailable for ${agent.modelSelection.instanceId}.`,
            nodeId,
            control: `${prefix}skill`,
          });
      }
    }
    const reasons = problems
      .filter((problem) => problem.severity === "error")
      .map((problem) => problem.message);
    return {
      source: "validation",
      definition,
      runnable: reasons.length === 0,
      reasons,
      problems,
    } satisfies CatalogEntry;
  });
  const readFile = Effect.fnUntraced(function* (filename: string, source: string) {
    const stat = yield* fs.stat(filename);
    if (Number(stat.size) > limits.definitionBytes)
      return {
        source,
        packaged: false,
        fingerprint: yield* hash(`size:${String(stat.size)}:${String(stat.mtime)}`),
        contents: null,
        parsed: undefined,
        definition: null,
        reason: sizeReason,
        duplicate: false,
      } satisfies Scanned;
    const contents = yield* fs.readFileString(filename);
    const base = {
      source,
      packaged: false,
      fingerprint: yield* hash(contents),
      contents,
      duplicate: false,
    };
    const parsed = yield* Effect.try({
      try: (): unknown => Yaml.parse(contents, { maxAliasCount: 32 }),
      catch: () => "Invalid workflow YAML.",
    }).pipe(Effect.result);
    if (parsed._tag === "Failure")
      return { ...base, parsed: undefined, definition: null, reason: parsed.failure };
    const definition = yield* decode(parsed.success).pipe(Effect.result);
    return definition._tag === "Success"
      ? { ...base, parsed: undefined, definition: definition.success, reason: null }
      : {
          ...base,
          parsed: parsed.success,
          definition: null,
          reason: `Invalid workflow schema: ${definition.failure.message.slice(0, 1_000)}`,
        };
  });
  /** Every source in the project catalog; display bounds apply only to transports. */
  const scan = Effect.fnUntraced(function* (input: Scope) {
    const directory = yield* root(input);
    const files = (yield* fs.exists(directory))
      ? (yield* fs.readDirectory(directory))
          .filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]*\.ya?ml$/.test(name))
          .sort()
      : [];
    const authored: Scanned[] = [];
    for (const file of files) {
      const source = `${location}/${file}`;
      const result = yield* readFile(path.join(directory, file), source).pipe(Effect.result);
      authored.push(
        result._tag === "Success"
          ? result.success
          : {
              source,
              packaged: false,
              fingerprint: yield* hash(`unreadable:${source}`),
              contents: null,
              parsed: undefined,
              definition: null,
              reason: isPluginError(result.failure)
                ? result.failure.message
                : "Invalid or unreadable workflow definition.",
              duplicate: false,
            },
      );
    }
    const counts = new Map<string, number>();
    for (const entry of authored)
      if (entry.definition)
        counts.set(entry.definition.id, (counts.get(entry.definition.id) ?? 0) + 1);
    const packaged: Scanned[] = [];
    for (const definition of examples)
      if (!counts.has(definition.id))
        packaged.push({
          source: `packaged:${definition.id}`,
          packaged: true,
          fingerprint: yield* hash(definition),
          contents: null,
          parsed: undefined,
          definition,
          reason: null,
          duplicate: false,
        });
    return [
      ...packaged,
      ...authored.map((entry) =>
        entry.definition && counts.get(entry.definition.id)! > 1
          ? { ...entry, duplicate: true }
          : entry,
      ),
    ];
  });
  /** Full validation of one scanned source, keeping parser reasons and duplicate state. */
  const evaluate = Effect.fnUntraced(function* (scope: Scope, entry: Scanned, shared?: Discovery) {
    const validation = entry.definition
      ? yield* validate(scope, entry.definition, shared)
      : {
          definition: null,
          runnable: false,
          reasons: [entry.reason ?? "Invalid or unreadable workflow definition."],
          problems: [
            {
              severity: "error" as const,
              message: entry.reason ?? "Invalid or unreadable workflow definition.",
            },
          ],
        };
    return entry.duplicate
      ? {
          ...validation,
          runnable: false,
          reasons: [...validation.reasons, duplicateReason],
          problems: [
            ...validation.problems,
            { severity: "error" as const, message: duplicateReason },
          ],
        }
      : validation;
  });
  const list = (input: Scope) =>
    protect(
      "catalog",
      Effect.gen(function* () {
        const shared = yield* discovery(input.projectId);
        const entries: CatalogEntry[] = [];
        for (const entry of yield* scan(input)) {
          // The legacy catalog keeps its reasons-only shape; located problems use library/read.
          const { problems: _problems, ...validation } = yield* evaluate(input, entry, shared);
          entries.push({ ...validation, source: entry.source });
        }
        return entries;
      }),
    );
  const summary = (definition: Definition) => ({
    steps: definition.nodes.length,
    agents: definition.nodes.filter((node) => node.kind === "agent").length,
    reviewers: definition.nodes.reduce(
      (count, node) => count + (node.kind === "parallel" ? node.branches.length : 0),
      0,
    ),
    checks: definition.nodes.filter((node) => node.kind === "check").length,
    decisions: definition.nodes.filter((node) => node.kind === "decision" || node.kind === "join")
      .length,
    humanGates: definition.nodes.filter((node) => node.kind === "human").length,
    ends: definition.nodes.filter((node) => node.kind === "end").length,
  });
  const library = (input: LibraryInput) =>
    protect(
      "library",
      Effect.gen(function* () {
        const query = input.query?.trim().toLowerCase() ?? "";
        const matching = (yield* scan(input)).filter(
          (entry) =>
            query === "" ||
            [entry.source, entry.definition?.id ?? "", entry.definition?.title ?? ""].some((text) =>
              text.toLowerCase().includes(query),
            ),
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 20;
        const page = matching.slice(offset, offset + limit);
        const shared = yield* discovery(input.projectId);
        const entries: LibraryEntry[] = [];
        for (const entry of page) {
          const validation = yield* evaluate(input, entry, shared);
          entries.push({
            source: entry.source,
            packaged: entry.packaged,
            fingerprint: entry.fingerprint,
            definitionId: entry.definition?.id ?? null,
            title: entry.definition?.title ?? null,
            revision: entry.definition?.revision ?? null,
            summary: entry.definition ? summary(entry.definition) : null,
            runnable: validation.runnable,
            duplicate: entry.duplicate,
            reasons: validation.reasons,
            problems: validation.problems,
          });
        }
        const texts = entries.flatMap((entry) => [
          entry.title ?? "",
          ...entry.reasons,
          ...entry.problems.map((problem) => problem.message),
        ]);
        const visible = [...(yield* Display.displayTexts(host, texts))];
        return {
          entries: entries.map((entry) => ({
            ...entry,
            title: entry.title === null ? (visible.shift(), null) : visible.shift()!,
            reasons: entry.reasons.map(() => visible.shift()!),
            problems: entry.problems.map((problem) => ({
              ...problem,
              message: visible.shift()!,
            })),
          })),
          total: matching.length,
          offset,
          nextOffset: offset + page.length < matching.length ? offset + page.length : null,
        } satisfies LibraryPage;
      }),
    );
  /** Authoring view: protected text becomes placeholders; reasons are display-redacted. */
  const authoring = Effect.fnUntraced(function* (entry: Scanned, scope: Scope) {
    const validation = yield* evaluate(scope, entry);
    let text: string;
    let definition: Definition | null = null;
    let protectedValues = 0;
    let lossless = true;
    if (entry.definition) {
      const safe = yield* protectDefinition(host, entry.definition, entry.fingerprint);
      definition = safe.value;
      protectedValues = safe.originals.size;
      text = Yaml.stringify(definition);
    } else if (entry.parsed !== undefined) {
      const safe = yield* protectParsed(host, entry.parsed, entry.fingerprint);
      protectedValues = safe.originals.size;
      text = Yaml.stringify(safe.value);
    } else {
      const contents = entry.contents ?? "";
      text = (yield* Display.displayTexts(host, [contents]))[0] ?? "";
      lossless = text === contents;
    }
    const messages = [...validation.reasons, ...validation.problems.map((item) => item.message)];
    const visible = [...(yield* Display.displayTexts(host, messages))];
    return {
      source: entry.source,
      packaged: entry.packaged,
      fingerprint: entry.fingerprint,
      definition,
      runnable: validation.runnable,
      reasons: validation.reasons.map(() => visible.shift()!),
      problems: validation.problems.map((problem) => ({ ...problem, message: visible.shift()! })),
      duplicate: entry.duplicate,
      text,
      protectedValues,
      lossless,
    } satisfies AuthoringEntry;
  });
  const read = (input: ReadInput) =>
    protect(
      "read",
      Effect.gen(function* () {
        const entry = (yield* scan(input)).find((entry) => entry.source === input.source);
        if (!entry)
          return yield* error(
            "read",
            "This workflow source is no longer in the project catalog.",
            "unavailable",
          );
        return yield* authoring(entry, input);
      }),
    );
  /** Placeholders resolve only against the unchanged source whose fingerprint issued them. */
  const restore = (scope: Scope, definition: Definition) =>
    restoreDefinition(definition, (prefix) =>
      protect(
        "restore",
        Effect.gen(function* () {
          const source = (yield* scan(scope)).find((entry) => entry.fingerprint.startsWith(prefix));
          if (!source) return undefined;
          if (source.definition)
            return (yield* protectDefinition(host, source.definition, source.fingerprint))
              .originals;
          if (source.parsed !== undefined)
            return (yield* protectParsed(host, source.parsed, source.fingerprint)).originals;
          return undefined;
        }),
      ),
    );
  const write = Effect.fnUntraced(function* (directory: string, filename: string, text: string) {
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = yield* fs.makeTempFile({ directory, prefix: ".workflow-", suffix: ".yaml" });
    yield* fs.writeFileString(temporary, text);
    yield* fs
      .rename(temporary, filename)
      .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
  });
  const written = (scope: Scope, source: string, text: string, definition: Definition) =>
    Effect.gen(function* () {
      const fingerprint = yield* hash(text);
      return yield* authoring(
        {
          source,
          packaged: false,
          fingerprint,
          contents: text,
          parsed: undefined,
          definition,
          reason: null,
          duplicate: false,
        },
        scope,
      );
    });
  const save = (input: SaveInput) =>
    protect(
      "save",
      Effect.gen(function* () {
        const directory = yield* root(input);
        const restored = yield* restore(input, input.definition);
        const entry = yield* validate(input, restored);
        if (!entry.runnable) return yield* error("save", entry.reasons.join(" "));
        const authored = (yield* scan(input)).filter(
          (entry) => !entry.packaged && entry.definition?.id === restored.id,
        );
        if (authored.length > 1) return yield* error("save", duplicateReason, "conflict");
        const source = authored[0]?.source ?? `${location}/${restored.id}.yaml`;
        const filename = path.join(directory, path.basename(source));
        if (!authored[0] && (yield* fs.exists(filename)))
          return yield* error(
            "save",
            "The destination already contains another or invalid workflow definition.",
            "conflict",
          );
        const previous = authored[0]?.definition;
        if (
          (previous?.revision ?? null) !== input.expectedRevision ||
          restored.revision !== (input.expectedRevision ?? 0) + 1 ||
          (input.fingerprint !== undefined &&
            authored[0] !== undefined &&
            authored[0].fingerprint !== input.fingerprint)
        )
          return yield* error(
            "save",
            "The workflow revision changed. Reload before saving.",
            "conflict",
          );
        const text = Yaml.stringify(entry.definition);
        yield* write(directory, filename, text);
        return yield* written(input, source, text, entry.definition);
      }).pipe(lock.withPermits(1)),
    );
  const replace = (input: ReplaceInput) =>
    protect(
      "replace",
      Effect.gen(function* () {
        const directory = yield* root(input);
        const sources = yield* scan(input);
        const current = sources.find((entry) => entry.source === input.source);
        if (!current || current.packaged)
          return yield* error(
            "replace",
            "Only an authored workflow file in this project catalog can be replaced.",
            "unavailable",
          );
        if (current.fingerprint !== input.fingerprint)
          return yield* error(
            "replace",
            "The workflow file changed since it was read. Reload it before replacing.",
            "conflict",
          );
        const restored = yield* restore(input, input.definition);
        const entry = yield* validate(input, restored);
        if (!entry.runnable) return yield* error("replace", entry.reasons.join(" "));
        if (
          sources.some(
            (other) =>
              !other.packaged &&
              other.source !== input.source &&
              other.definition?.id === restored.id,
          )
        )
          return yield* error(
            "replace",
            `Another workflow file already uses the identity ${restored.id}.`,
            "conflict",
          );
        const text = Yaml.stringify(entry.definition);
        yield* write(directory, path.join(directory, path.basename(input.source)), text);
        return yield* written(input, input.source, text, entry.definition);
      }).pipe(lock.withPermits(1)),
    );
  const capabilities = (input: Scope) =>
    protect(
      "capabilities",
      Effect.gen(function* () {
        yield* root(input);
        const discovered = yield* host.providers().pipe(Effect.result);
        return {
          nodeKinds: [...nodeKinds],
          providers:
            discovered._tag === "Success"
              ? discovered.success.map((provider) => ({
                  instanceId: provider.instanceId,
                  driver: provider.driver,
                  displayName: provider.displayName ?? null,
                  available: provider.available === true,
                  reporting: provider.toolsSupported,
                  reason: provider.reason,
                  runtimeModes: provider.runtimeModes,
                  models: provider.models ?? [],
                }))
              : [],
          discoveryError: discovered._tag === "Failure" ? discovered.failure.message : null,
        } satisfies Capabilities;
      }),
    );
  const skills = (input: Scope & { readonly providerInstanceId: ProviderInstanceId }) =>
    protect(
      "skills",
      Effect.gen(function* () {
        yield* root(input);
        const found = yield* (yield* discovery(input.projectId)).skills(input.providerInstanceId);
        if (found._tag === "Failure") return yield* found.failure;
        return found.success.map((skill) => ({
          name: skill.name,
          displayName: skill.displayName ?? null,
          description: skill.shortDescription ?? skill.description ?? null,
          enabled: skill.enabled,
        }));
      }),
    );
  const projects = (input: { readonly environmentId: EnvironmentId }) =>
    protect(
      "projects",
      environment(input.environmentId, "projects").pipe(
        Effect.andThen(host.projects()),
        Effect.map((projects) => projects.map(({ id, title }) => ({ id, title }))),
      ),
    );
  const displayEntry = (entry: CatalogEntry) =>
    Display.displayCatalog(host, [entry]).pipe(Effect.map((entries) => entries[0]!));
  return Catalog.of({
    validate: (scope, definition) => validate(scope, definition).pipe(Effect.flatMap(displayEntry)),
    list: (input) =>
      list(input).pipe(
        // Save and execution resolve identities from every source; only transport is bounded.
        Effect.map((entries) => entries.slice(0, 100 + examples.length)),
        Effect.flatMap((entries) => Display.displayCatalog(host, entries)),
      ),
    library,
    read,
    save,
    replace,
    capabilities,
    skills,
    projects,
    resolve: (input, definitionId) =>
      list(input).pipe(
        Effect.map((entries) => entries.find((entry) => entry.definition?.id === definitionId)),
      ),
  });
});
export const layer = Layer.effect(Catalog, make);
