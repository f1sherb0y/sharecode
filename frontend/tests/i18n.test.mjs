import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const root = new URL('../src/', import.meta.url)
const flatten = (object, prefix = '') => Object.fromEntries(
  Object.entries(object).flatMap(([key, value]) => typeof value === 'object'
    ? Object.entries(flatten(value, `${prefix}${key}.`))
    : [[prefix + key, value]])
)
const locales = Object.fromEntries(['en', 'zh'].map(locale => [locale,
  flatten(JSON.parse(readFileSync(new URL(`i18n/locales/${locale}.json`, root), 'utf8'))),
]))
const sources = readdirSync(root, { recursive: true })
  .filter(file => /\.tsx?$/.test(file))
  .map(file => ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true))

test('English and Chinese cover the same keys and interpolation parameters', () => {
  assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.zh).sort())
  const params = text => [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)].map(match => match[1]).sort()
  for (const [key, value] of Object.entries(locales.en)) {
    assert.ok(value.trim() && locales.zh[key].trim(), key)
    assert.deepEqual(params(value), params(locales.zh[key]), key)
  }
})

test('literal translation keys in app code exist in both languages', () => {
  const missing = []
  const check = (key, source) => {
    for (const [locale, values] of Object.entries(locales)) {
      if (!(key in values)) missing.push(`${source.fileName}: ${locale}: ${key}`)
    }
  }
  const checkArgument = (arg, source) => {
    if (ts.isStringLiteral(arg)) check(arg.text, source)
    else if (ts.isConditionalExpression(arg)) {
      checkArgument(arg.whenTrue, source)
      checkArgument(arg.whenFalse, source)
    }
  }
  for (const source of sources) {
    function visit(node) {
      if (ts.isCallExpression(node) && ['t', 'i18n.t'].includes(node.expression.getText(source)) && node.arguments[0]) {
        checkArgument(node.arguments[0], source)
      }
      if (source.fileName === 'i18n/errors.ts' && ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
        check(node.initializer.text, source)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(missing, [])
})

test('app chrome has no untranslated text or accessible labels', () => {
  // Product names, language autonyms, units, and literal key chords stay unchanged.
  const literals = new Set(['ShareCode', 'English', '中文', 's', 'MB', '0.5x', '1x', '2x', '5x', '10x', 'Ctrl+Shift+H', 'Ctrl+Shift+T', 'Ctrl+Shift+U/I/O/J/K/L/M/,/.'])
  const untranslated = []
  for (const source of sources) {
    function record(node, text) {
      text = text.trim()
      if (!/[a-zA-Z\u4e00-\u9fff]/.test(text) || literals.has(text)) return
      // Portable exports deliberately use stable user1/user2 identifiers and a
      // bilingual language selector, independent of the selected UI language.
      if (source.fileName === 'export/runtime.tsx' && ['user', 'Language / 语言'].includes(text)) return
      untranslated.push(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text}`)
    }
    function visit(node) {
      if (ts.isJsxText(node)) record(node, node.text)
      if (ts.isJsxAttribute(node) && ['title', 'aria-label', 'placeholder', 'alt'].includes(node.name.text)
        && node.initializer && ts.isStringLiteral(node.initializer)) record(node, node.initializer.text)
      if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)) record(node, node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(untranslated, [])
})
