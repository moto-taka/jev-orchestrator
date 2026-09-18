class Jvo < Formula
  desc "Jev decision-only orchestration for local coding agents"
  homepage "https://github.com/moto-taka/jev-orchestrator"
  # Preserve the existing SSH installation route; never embed credentials.
  # Pin the verified application commit, not the mutable main branch.
  url "ssh://git@github.com/moto-taka/jev-orchestrator.git",
      using: :git,
      revision: "251bed84e8c02937f84ebf0f8c8a713a9f13dc50"
  version "0.3.2"
  license "MIT"

  depends_on "node@24"
  uses_from_macos "git"

  def install
    node = Formula["node@24"].opt_bin/"node"
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
      Run `jvo setup` for first-time Jev configuration.
      Run `jvo models` to select multiple allowed models for each CLI.
      Jev selects the model and role; routine delivery and continuation use code.
      In a project, run `jvo trust`, then `jvo`; `/messages` shows native peer conversations.
      `jvo demo` runs an isolated local workflow without API credentials.
      `jvo triage reports.json` reviews saved reports with rules only by default.
      Add --allow-api for Jev triage; an advisory operator requires --allow-worker.

      Git source downloads use your existing GitHub SSH access.
      Agent CLIs, their authentication and your shell's Node are not changed.
      Existing runs retain their policy. Pause/exit, then use
      `jvo resume <run-id> --refresh-policy` to opt into the lean execution rules.
    EOS
  end

  test do
    ENV["JVO_HOME"] = (testpath/"state").to_s
    ENV["TMPDIR"] = testpath.to_s
    assert_equal version.to_s, shell_output("#{bin}/jvo --version").strip
    help = shell_output("#{bin}/jvo --help")
    assert_match "Jev Orchestrator", help
    assert_match "jvo models", help
    assert_match "jvo messages", help
    assert_match "jvo triage", help
    result = JSON.parse(shell_output("#{bin}/jvo demo --json").lines.last)
    assert_equal true, result.fetch("demo")
    assert_equal "ready_for_user_apply", result.fetch("status")
    assert_equal true, result.fetch("journalValid")
    assert_equal 2, result.fetch("attempts").find { |task| task.fetch("id") == "T1" }.fetch("attempts")
    reports = testpath/"reports.json"
    reports.write JSON.generate([
      { id: "heartbeat", kind: "heartbeat", text: "" },
      { id: "completed", kind: "completed", text: "Work completed" },
    ])
    triage = JSON.parse(shell_output("#{bin}/jvo triage #{reports}"))
    assert_equal 0, triage.fetch("jevCalls")
    assert_equal 0, triage.fetch("operatorCalls")
    assert_equal 2, triage.fetch("archive").length
    assert_equal "completed", triage.fetch("attention").first.fetch("id")
  end
end
