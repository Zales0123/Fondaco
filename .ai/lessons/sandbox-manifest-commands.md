---
title: "Sandbox manifests use command arrays and platform data services"
modules: ["platform"]
areas: ["architecture"]
topics: ["sandbox", "configuration", "startup"]
---

# Sandbox manifests use command arrays and platform data services

**Context**: Importing Fondaco into a Custom / Bring Your Own Project sandbox.

**Problem**: Version 2 rejects prepare tables and process env, port, or cwd properties.

**Rule**: Define `prepare` as an array of command arrays and `[preview].command` as a command array. Put working-directory and environment setup in scripts or shell commands. Use the existing platform PostgreSQL and Redis, bind the preview to `0.0.0.0:3000`, and apply manifest changes with `workspace-agent-cli start`.

**Applies to**: `openmercato.toml` and `scripts/sandbox-prepare.sh`.
