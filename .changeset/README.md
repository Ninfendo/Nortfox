# Changesets

A changeset records what users will notice in a change. Add one in the same PR:

```sh
pnpm changeset
```

Only the API client, `@nortfox/client`, is published. Every other package is private, and its changes reach users through a NortFox release. See [CONTRIBUTING.md](../CONTRIBUTING.md).
