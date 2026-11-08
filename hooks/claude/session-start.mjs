// Хук Claude Code SessionStart: напоминает агенту о стандарте документов и сообщает, если
// каталог submodule пуст или документы уже расходятся со стандартом. Ничего не блокирует:
// текст на stdout попадает агенту как контекст сессии.
//
//   node docs/standards/hooks/claude/session-start.mjs [аргументы check-docs.mjs]
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const HERE = import.meta.dirname
const STANDARDS = path.resolve(HERE, "..", "..")
const CHECK = path.join(STANDARDS, "scripts", "check-docs.mjs")
const relStandards = path.relative(ROOT, STANDARDS).replaceAll("\\", "/") || "docs/standards"

if (!fs.existsSync(path.join(STANDARDS, "README.md"))) {
  console.log(
    `Каталог ${relStandards} пуст: канон документов не подтянут. Выполни git submodule update --init ${relStandards} ` +
      "до правки ADR, требований и контрактов.",
  )
  process.exit(0)
}

const result = spawnSync(process.execPath, [CHECK, ...process.argv.slice(2)], { cwd: ROOT, encoding: "utf8" })
const summary =
  result.status === 0
    ? "Документы соответствуют стандарту."
    : `Документы уже расходятся со стандартом (${`${result.stderr}${result.stdout}`.trim().split("\n").filter(Boolean).length} строк в отчёте): ` +
      `запусти node ${relStandards}/scripts/check-docs.mjs и исправь до новых правок.`
console.log(
  `Стандарт документов: ADR в docs/architecture/decisions, карточки требований в docs/requirements, контракты в docs/contracts ` +
    `пишутся по шаблонам из ${relStandards}/ (adr-template.md, requirement-template.md, contract-template.md), ` +
    `следующий номер по порядку, решение человека помечается decided_by: owner с датой, своё предложение остаётся Proposed или Draft. ` +
    `После правки документа хук проверит его сам. ${summary}`,
)
