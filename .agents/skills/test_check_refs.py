"""Regression tests for the local skill reference checker; stdlib only."""

import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "check_refs", Path(__file__).with_name("check-refs.py")
)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class CheckRefsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="skill-refs-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.installed = self.root / "installed"
        self.source = self.root / "source"
        self.installed.mkdir()
        self.source.mkdir()
        root_patch = patch.object(checker, "RAIZ", str(self.installed))
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def skill(self, root, name, text=""):
        directory = root / name
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "SKILL.md"
        path.write_text(text, encoding="utf-8")
        return path

    def check(self, *sources):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = checker.main(["check-refs.py", *map(str, sources)])
        return code, output.getvalue()

    def test_missing_arguments_show_usage(self):
        code, output = self.check()
        self.assertEqual(code, 2)
        self.assertIn("<pasta-de-skills-de-origem>", output)

    def test_nonexistent_origin_is_an_input_error(self):
        missing = self.root / "missing"
        code, output = self.check(missing)
        self.assertEqual(code, 2)
        self.assertIn("origem inexistente: " + str(missing), output)

    def test_empty_origin_is_an_input_error(self):
        self.assertEqual(
            self.check(self.source),
            (2, "nenhuma skill encontrada nas origens\n"),
        )

    def test_invalid_secondary_origin_is_not_ignored(self):
        self.skill(self.source, "dependency")
        code, output = self.check(self.source, self.root / "missing")
        self.assertEqual(code, 2)
        self.assertIn("origem inexistente", output)

    def test_dangling_reference_reports_caller_target_path_and_line(self):
        self.skill(self.source, "dependency")
        path = self.skill(self.installed, "caller", "# Caller\nUse `dependency`.\n")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        self.assertIn("caller -> dependency ausente", output)
        self.assertIn(str(path) + ":2  Use `dependency`.", output)

    def test_installing_dependency_clears_the_finding(self):
        self.skill(self.source, "dependency")
        self.skill(self.installed, "caller", "Use `dependency`.")
        self.assertEqual(self.check(self.source)[0], 1)
        self.skill(self.installed, "dependency")
        self.assertEqual(
            self.check(self.source),
            (0, "nenhuma referencia pendurada (2 skills)\n"),
        )

    def test_multiple_origins_are_combined_including_nested_skills(self):
        other = self.root / "other"
        self.skill(self.source, "first")
        self.skill(other, "nested/second")
        self.skill(self.installed, "caller", "Use `first` and `second`.")
        code, output = self.check(self.source, other)
        self.assertEqual(code, 1)
        self.assertIn("caller -> first ausente", output)
        self.assertIn("caller -> second ausente", output)

    def test_principle_alias_resolves_to_full_skill_name(self):
        self.skill(self.source, "principle-prove-it-works")
        self.skill(self.installed, "caller", "Use **prove-it-works**.")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        self.assertIn("caller -> principle-prove-it-works ausente", output)
        self.skill(self.installed, "principle-prove-it-works")
        self.assertEqual(self.check(self.source)[0], 0)

    def test_accepted_references_are_limited_to_the_documented_callers(self):
        pairs = (("how", "interrogate"), ("triage", "setup-matt-pocock-skills"))
        for caller, target in pairs:
            self.skill(self.source, target)
            self.skill(self.installed, caller, "Use /" + target)
        self.assertEqual(self.check(self.source)[0], 0)
        self.skill(self.installed, "other", "Use /interrogate and /setup-matt-pocock-skills")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        for _, target in pairs:
            self.assertIn("other -> " + target + " ausente", output)

    def test_catalog_exceptions_do_not_hide_calls_on_other_lines(self):
        targets = ("convex-agent", "convex-improve-convex-plugin")
        catalog = "".join("- **" + target + "**: Description.\n" for target in targets)
        for target in targets:
            self.skill(self.source, target)
        self.skill(self.installed, "convex", catalog)
        self.assertEqual(self.check(self.source)[0], 0)
        calls = "".join("Use `" + target + "`.\n" for target in targets)
        self.skill(self.installed, "convex", catalog + calls)
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        for target in targets:
            self.assertIn("convex -> " + target + " ausente", output)
        self.assertNotIn("Description.", output)

    def test_catalog_exceptions_do_not_apply_to_other_skills(self):
        self.skill(self.source, "convex-agent")
        self.skill(self.installed, "other", "- **convex-agent**: Description.")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        self.assertIn("other -> convex-agent ausente", output)

    def test_support_files_are_checked_recursively(self):
        self.skill(self.source, "dependency")
        self.skill(self.installed, "caller")
        support = self.installed / "caller" / "references"
        support.mkdir()
        for name in ("guide.md", "script.sh", "agent.yaml"):
            (support / name).write_text('Use "dependency".\n', encoding="utf-8")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        for name in ("guide.md", "script.sh", "agent.yaml"):
            self.assertIn(str(support / name) + ":1", output)

    def test_git_metadata_and_directories_without_skills_are_ignored(self):
        self.skill(self.source, "known")
        self.skill(self.source, ".git/ghost")
        self.skill(self.installed, "caller", "Use `ghost`.")
        metadata = self.installed / "caller" / ".git"
        metadata.mkdir()
        (metadata / "notes.md").write_text("Use `known`.", encoding="utf-8")
        (self.installed / "licenses").mkdir()
        self.assertEqual(
            self.check(self.source),
            (0, "nenhuma referencia pendurada (1 skills)\n"),
        )

    def test_plain_english_does_not_trigger_how_or_why(self):
        self.skill(self.source, "how")
        self.skill(self.source, "why")
        self.skill(self.installed, "caller", "Explain how and why this works.")
        self.assertEqual(self.check(self.source)[0], 0)
        self.skill(self.installed, "caller", "Use `how` and **why**.")
        code, output = self.check(self.source)
        self.assertEqual(code, 1)
        self.assertIn("caller -> how ausente", output)
        self.assertIn("caller -> why ausente", output)


if __name__ == "__main__":
    unittest.main()
