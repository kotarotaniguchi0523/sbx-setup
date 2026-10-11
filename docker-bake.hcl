# Parallel multi-target build for the sbx templates.
#   docker buildx bake -f sbx-setup/docker-bake.hcl
# BuildKit builds both targets concurrently. The opencode target runs the
# pstack conversion inside its image build.

group "default" {
  targets = ["opencode", "codex"]
}

target "opencode" {
  context    = "."
  dockerfile = "common-opencode/common-opencode.yaml"
  tags       = ["common-opencode:dev"]
}

target "codex" {
  context    = "./common-codex"
  dockerfile = "common-codex.yaml"
  tags       = ["common-codex:dev"]
}
