# Effect Outcomes

Effect Outcomes is a proposed TypeScript library for recording what is known about consequential external actions. It is intended for AI-driven applications and backend systems that call payment providers, account services, and other systems where repeating an action can have real consequences.

An external system may complete an action while the caller loses its response. After a timeout or crash, the caller cannot safely infer whether the action happened. Retrying blindly can duplicate it; treating the timeout as a failure can hide a completed action.

The planned library will associate each logical operation with a stable, trusted key and an input fingerprint. It will record confirmed success, confirmed absence of an effect, or an unknown outcome. Reusing a key with different input will be a conflict. An unknown outcome will require explicit, evidence-based reconciliation before the operation can be treated as resolved. Provider-specific lookup and reconciliation will live behind adapters or callbacks.

The project does **not** promise exactly-once execution. It will not automatically retry an action with an unknown external outcome.

## Status

This repository currently contains the TypeScript package foundation and a proposed architecture. There is no usable outcome-tracking API, durable store, or published npm release yet. The package is marked private until its behavior is implemented and verified.

See the [project roadmap](docs/EFFECT_OUTCOMES_ROADMAP.md) for the state model, implementation phases, open questions, and current status.

## Development

Node.js 22 or newer and npm are required.

```sh
npm ci
npm run typecheck
npm run build
```

The build writes ESM JavaScript and TypeScript declarations to `dist/`. Tests will be added alongside the first behavior-bearing implementation.

## License

Apache-2.0. See [LICENSE](LICENSE).
