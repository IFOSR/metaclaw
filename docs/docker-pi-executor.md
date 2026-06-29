# Docker Pi Executor

`Dockerfile.test` installs Node 22, MetaClaw dependencies, native build tooling, `curl`, and the Pi CLI:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.2
```

MetaClaw itself supports Node >=20, but Pi `0.80.2` requires Node >=22.19.0, so the Docker test/runtime image uses Node 22.

Do not put API keys in the Dockerfile. Build layers, cache, image history, and registries can expose them. Use an env file or runtime environment variables instead.

## Build

```bash
docker build -f Dockerfile.test -t metaclaw-test .
```

## Configure Secrets

Copy the template and fill one provider key:

```bash
cp docker/pi.env.example docker/pi.env
```

For the Pi quick-start path, set:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

`docker/pi.env` is ignored by Git through `.dockerignore`; keep it local and do not commit it.

## Verify Pi Is Installed

```bash
docker run --rm --env-file docker/pi.env metaclaw-test bash -lc "pi --help"
```

## Run MetaClaw With Pi

The quickest interactive path:

```bash
docker run --rm -it --env-file docker/pi.env metaclaw-test bash -lc "npm run build && mkdir -p /tmp/metaclaw-home && cat > /tmp/metaclaw-home/config.yaml <<'YAML'
version: 1
executor:
  command: pi
  timeout: 900
  max_duration: 3600
orchestration:
  reminder_enabled: false
  reminder_throttle: 300
  top_k_preferences: 5
  blocked_recheck_enabled: false
ui:
  language: zh-CN
  dashboard_on_start: false
YAML
METACLAW_HOME=/tmp/metaclaw-home node dist/index.js"
```

Inside the TUI, try:

```text
/executor list
/executor route 请调研 Pi Agent 的能力并输出一个简短报告
请调研 Pi Agent 的能力并输出一个简短报告
```
