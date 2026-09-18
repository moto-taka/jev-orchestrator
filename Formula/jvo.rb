class Jvo < Formula
  desc "Jev decision-only orchestration for local coding agents"
  homepage "https://github.com/moto-taka/jev-orchestrator"
  # Keep the source private. Git uses the user's existing SSH agent/config.
  # Pin the tested application commit, not the mutable main branch.
  url "ssh://git@github.com/moto-taka/jev-orchestrator.git",
      using: :git,
      revision: "6a122bff5506d521a1230eb78379e3d0dccc13a3"
  version "0.1.0"
  license "MIT"

  depends_on "node@24"
  uses_from_macos "git"

  def install
    node = Formula["node@24"].opt_bin/"node"
    # This uses Node's built-in type stripper. It neither downloads npm packages
    # nor runs project setup, agent discovery, credential prompts or API calls.
    system node, "--disable-warning=ExperimentalWarning", "scripts/build.mjs"
    libexec.install "bin", "dist", "package.json"
    pkgshare.install "docs", "examples"
    (bin/"jvo").write <<~SH
      #!/bin/sh
      exec "#{node}" "#{libexec}/bin/jvo.mjs" "$@"
    SH
    (bin/"jvo").chmod 0755
  end

  def caveats
    <<~EOS
      Run `jvo setup` to configure Jev and select your installed coding CLIs.
      In a project, run `jvo trust`, then `jvo`.
      `jvo demo` exercises an isolated local workflow without API credentials.

      This tap and its source are private. Updates require GitHub SSH access.
      Your agent CLIs and their authentication are not installed or changed.
      The bundled Node.js path is used without changing your shell's Node.
    EOS
  end

  test do
    ENV["JVO_HOME"] = (testpath/"state").to_s
    ENV["TMPDIR"] = testpath.to_s
    assert_equal version.to_s, shell_output("#{bin}/jvo --version").strip
    assert_match "Jev Orchestrator", shell_output("#{bin}/jvo --help")
    result = JSON.parse(shell_output("#{bin}/jvo demo --json").lines.last)
    assert_equal true, result.fetch("demo")
    assert_equal "ready_for_user_apply", result.fetch("status")
    assert_equal true, result.fetch("journalValid")
    assert_equal 2, result.fetch("attempts").find { |task| task.fetch("id") == "T1" }.fetch("attempts")
  end
end
