# Git Hooks

随机单元测试 pre-commit（task2app 模式）：暂存相关测例优先，其余按比例随机抽测。
commit-msg：bug-fix 提交必须携带对应回归单测（41_bug_fix_unit_test_required.md）。

模板来源：`db/scripts/hooks/templates/pre-commit.python`（monorepo）。
安装：`bash scripts/hooks/install.sh`

规则：`.ai/01_project_constraints/28_commit_random_unit_test_debt_fix.md`
`.ai/01_project_constraints/41_bug_fix_unit_test_required.md`
