# Parallel multi-target build for the sbx templates.
#   docker buildx bake -f sbx-setup/docker-bake.hcl
# BuildKit builds all targets concurrently. The opencode target runs the
# pstack conversion inside its image build.

group "default" {
  targets = ["opencode", "codex", "claude"]
}

target "opencode" {
  context    = "."
  dockerfile = "common-opencode/common-opencode.yaml"
  tags       = ["common-opencode:dev"]
}

target "codex" {
  context    = "."
  dockerfile = "common-codex/common-codex.yaml"
  tags       = ["common-codex:dev"]
}

target "claude" {
  context    = "."
  dockerfile = "common-claude/common-claude.yaml"
  tags       = ["common-claude:dev"]
}
