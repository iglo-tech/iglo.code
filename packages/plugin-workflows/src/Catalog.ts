import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError, type ProjectId } from "@t3tools/plugin-host-contract/schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Yaml from "yaml";
import { Definition, type CatalogEntry, type SaveInput, type ScopeInput } from "./contracts.ts";
import { agents, definitionProblems } from "./definition.ts";
import { error, protect } from "./encoding.ts";
import { examples } from "./examples.ts";

const isPluginError = Schema.is(PluginError);
export const location = ".t3code/workflows";
const decode = Schema.decodeUnknownEffect(Definition);
export class Catalog extends Context.Service<
  Catalog,
  {
    readonly validate: (
      scope: typeof ScopeInput.Type,
      definition: Definition,
    ) => Effect.Effect<CatalogEntry, PluginError>;
    readonly list: (
      input: typeof ScopeInput.Type,
    ) => Effect.Effect<ReadonlyArray<CatalogEntry>, PluginError>;
    readonly save: (input: typeof SaveInput.Type) => Effect.Effect<CatalogEntry, PluginError>;
  }
>()("@t3tools/plugin-workflows/Catalog") {}

const make = Effect.gen(function* () {
  const host = yield* Host;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const root = Effect.fnUntraced(function* (input: typeof ScopeInput.Type) {
    if (input.environmentId !== host.environmentId)
      return yield* error(
        "catalog",
        "The requested environment is not this server.",
        "unavailable",
      );
    const project = (yield* host.projects()).find((project) => project.id === input.projectId);
    if (!project) return yield* error("catalog", "The project is unavailable.", "unavailable");
    return path.join(project.workspaceRoot, location);
  });
  const validate = Effect.fn("Workflows.validate")(function* (
    scope: typeof ScopeInput.Type,
    input: Definition,
  ) {
    yield* root(scope);
    const projectId = scope.projectId;
    const definition = yield* decode(input).pipe(
      Effect.mapError((cause) =>
        error("validate", "Invalid workflow schema.", "validation", cause),
      ),
    );
    const reasons = definitionProblems(definition);
    const providers = yield* host.providers();
    for (const agent of agents(definition)) {
      const provider = providers.find(
        (provider) => provider.instanceId === agent.modelSelection.instanceId,
      );
      if (
        !provider?.toolsSupported ||
        provider.available !== true ||
        !provider.runtimeModes.includes(agent.runtimeMode)
      )
        reasons.push(
          `Provider ${agent.modelSelection.instanceId} cannot report in ${agent.runtimeMode}: ${provider?.reason ?? "unavailable"}.`,
        );
      if (agent.skill) {
        const skills = yield* host.skills({
          projectId,
          providerInstanceId: agent.modelSelection.instanceId,
        });
        if (!skills.some((skill) => skill.name === agent.skill && skill.enabled))
          reasons.push(
            `Skill ${agent.skill} is unavailable for ${agent.modelSelection.instanceId}.`,
          );
      }
    }
    return { source: "validation", definition, runnable: reasons.length === 0, reasons };
  });
  const read = Effect.fnUntraced(function* (filename: string, projectId: ProjectId) {
    const stat = yield* fs.stat(filename);
    if (Number(stat.size) > 524_288)
      return yield* error("catalog", "Workflow YAML exceeds 512 KiB.");
    const contents = yield* fs.readFileString(filename);
    const parsed = yield* Effect.try({
      try: () => Yaml.parse(contents, { maxAliasCount: 32 }),
      catch: (cause) => error("catalog", "Invalid workflow YAML.", "validation", cause),
    });
    return yield* decode(parsed).pipe(
      Effect.flatMap((definition) =>
        validate({ environmentId: host.environmentId, projectId }, definition),
      ),
    );
  });
  const list = (input: typeof ScopeInput.Type) =>
    protect(
      "catalog",
      Effect.gen(function* () {
        const directory = yield* root(input);
        const files = (yield* fs.exists(directory))
          ? (yield* fs.readDirectory(directory))
              .filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]*\.ya?ml$/.test(name))
              .sort()
              .slice(0, 100)
          : [];
        const entries: CatalogEntry[] = [];
        for (const definition of examples)
          entries.push({
            ...(yield* validate(input, definition)),
            source: `packaged:${definition.id}`,
          });
        for (const file of files) {
          const result = yield* read(path.join(directory, file), input.projectId).pipe(
            Effect.result,
          );
          entries.push(
            result._tag === "Success"
              ? { ...result.success, source: `${location}/${file}` }
              : {
                  source: `${location}/${file}`,
                  definition: null,
                  runnable: false,
                  reasons: [
                    isPluginError(result.failure)
                      ? result.failure.message
                      : "Invalid or unreadable workflow definition.",
                  ],
                },
          );
        }
        const authored = new Map<string, number>();
        for (const entry of entries)
          if (!entry.source.startsWith("packaged:") && entry.definition)
            authored.set(entry.definition.id, (authored.get(entry.definition.id) ?? 0) + 1);
        return entries
          .filter(
            (entry) =>
              !entry.source.startsWith("packaged:") ||
              !entry.definition ||
              !authored.has(entry.definition.id),
          )
          .map((entry) =>
            entry.definition &&
            !entry.source.startsWith("packaged:") &&
            authored.get(entry.definition.id)! > 1
              ? {
                  ...entry,
                  runnable: false,
                  reasons: [
                    ...entry.reasons,
                    "This workflow identity is duplicated in the project catalog.",
                  ],
                }
              : entry,
          );
      }),
    );
  const save = (input: typeof SaveInput.Type) =>
    protect(
      "save",
      Effect.gen(function* () {
        const directory = yield* root(input);
        const entry = yield* validate(input, input.definition);
        if (!entry.runnable) return yield* error("save", entry.reasons.join(" "));
        const filename = path.join(directory, `${input.definition.id}.yaml`);
        const exists = yield* fs.exists(filename);
        const previous = exists ? (yield* read(filename, input.projectId)).definition : null;
        if (
          (previous?.revision ?? null) !== input.expectedRevision ||
          input.definition.revision !== (input.expectedRevision ?? 0) + 1
        )
          return yield* error(
            "save",
            "The workflow revision changed. Reload before saving.",
            "conflict",
          );
        yield* fs.makeDirectory(directory, { recursive: true });
        const temporary = yield* fs.makeTempFile({
          directory,
          prefix: ".workflow-",
          suffix: ".yaml",
        });
        yield* fs.writeFileString(temporary, Yaml.stringify(input.definition));
        yield* fs
          .rename(temporary, filename)
          .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
        return { ...entry, source: `${location}/${input.definition.id}.yaml` };
      }).pipe(lock.withPermits(1)),
    );
  return Catalog.of({ validate, list, save });
});
export const layer = Layer.effect(Catalog, make);
