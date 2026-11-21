import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const diff = model + '(*DiffModel).';
const hooks = model + 'HooksModel.';
const foldLabel = model + 'foldLabel';
const style = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.Style.Render';
const concat = n => 'runtime.concatstring' + n;
const format = (text, offset = 28) => [0, 8, 0, 1, text, offset];
const str = (text, register, length = register + 1, distance = 8) => [0, distance, register, length, text];

function expression(name, literals, verifiedCalls = []) {
  return {name, optional:true, resolve:relocateStatusLiteralGroup, literals, verifiedCalls};
}
function formats(name, ...texts) {
  return texts.map(text => expression(name, [typeof text === 'string' ? format(text) : format(...text)]));
}
function labels(name, ...fields) {
  return fields.map(field => expression(name, [str(...field)]));
}
function rendered(name, text, register, offset) {
  return expression(name, [str(text, register)], [[offset, style]]);
}
function argument(name, text, register, offset, consumer, length = register + 1, distance = 8) {
  return expression(name, [str(text, register, length, distance)], [[offset, consumer]]);
}

// The native formatter appends "s" only when the count exceeds one. Keep that
// choice in the display expression: “钩子：1” / “钩子：2 个”.
function hookCount(name) {
  return expression(name, [format('  %d hook'), [52, 60, 3, 4, 's', undefined, 'cli-hook-count:']],
    [[72, concat(2)]]);
}

export const cliDiffHooksLiteralProfiles = [
  ...labels(diff + 'detailHints', ['discard edits', 3, 5], ['resume editing', 3],
    ['back', 3], ['next/prev diff', 4, 2, -4], ['search', 5], ['cycle file', 5],
    ['comment', 6, 6, -60], ['delete comment', 6], ['next conversation', 6, 6, -68],
    ['pick focused', 6], ['clear search', 4, 4, -48], ['back', 4, 4, -48]),
  ...formats(diff + 'detailHints', 'next/prev (%q)'),
  ...labels(diff + 'viewConfirm', ['send and exit', 5, 7], ['exit without sending', 5], ['cancel', 5]),
  ...formats(diff + 'viewBattleHeader', ['Best of %d │', 24]),
  ...labels(diff + 'appendBattleAndDismissHints', ['next conversation', 7, 6, -68],
    ['pick focused', 7], ['dismiss', 5, 5, -48]),
  ...formats(diff + 'viewFileList', '  %d file(s) changed'),
  ...labels(diff + 'viewFileList', ['dismiss', 8], ['dismiss', 9], ['dismiss', 5], ['dismiss', 8, 8, -12],
    ['navigate', 5], ['view diff', 5]),
  argument(diff + 'viewFileList', 'No commit history available', 3, 20, model + 'diffStatusView'),
  argument(diff + 'viewFileList', ' · checking for untracked files…', 3, 20, concat(2)),
  argument(diff + 'viewFileList', 'Loading diff…', 3, 28, model + 'diffStatusView'),
  expression(diff + 'viewFileList', [
    [0, -12, 8, 8, 'Checking for untracked files…'],
    [8, -8, 9, 9, 'No uncommitted changes'],
  ], [[52, model + 'diffStatusView']]),
  ...formats(diff + 'viewTurnFileList', '  %d turn(s), %d file(s) changed', ' · checking %d older turn(s)…', 'Turn %d'),
  ...labels(diff + 'viewTurnFileList', ['dismiss', 8], ['dismiss', 8, 8, -12]),
  argument(diff + 'viewTurnFileList', 'No file changes in conversation', 3, 20, model + 'diffStatusView'),
  argument(diff + 'viewTurnFileList', 'Loading diff…', 3, 28, model + 'diffStatusView'),
  ...formats(diff + 'viewFileDetail', '  … %d more lines (↓ to scroll)', '(Turn %d)'),
  ...formats(model + 'renderDiffLines', ['  … %d more lines (f for full diff)', 24]),
  argument(foldLabel, '%d unchanged lines', 2, 24, 'fmt.Fprintf'),
  {
    ...expression(foldLabel, [str('1 unchanged line', 27, 3, -36)], [[-24, 'runtime.growslice']]),
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      const [pointer, length] = located.literals[0];
      // Go copies one 16-byte vector straight into the folded-line label.
      return {...located, guards:[[pointer+8, 0x3dc00360], [pointer+12, 0x3d8000e0]],
        sharedLengths:[length]};
    },
  },
  ...labels(diff + 'viewFileDetail', ['No line-level diff data available', 2, 1, -4], ['back', 8, 8, -12]),
  argument(diff + 'viewFileDetail', 'Not shown: ', 1, 12, concat(2)),
  ...formats(diff + 'commitTreeSummary', ['latest %d commits shown', 24], ['%d commit(s) available', 24]),
  ...formats(diff + 'foldHints', ['show %d hidden matches', 24]),
  ...labels(diff + 'foldHints', ['show 1 hidden match', 0], ['full file', 0], ['changes only', 3], ['collapse', 6, 6, -20]),
  // The length of “expand” is also stored as the length of the key “ctrl+o”.
  {...expression(diff + 'foldHints', [str('expand', 5, 5, -28)]),
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      return {...located, sharedLengths:[located.literals[0][1]]};
    }},
  ...[diff + 'readFullFile', diff + 'toggleFold'].flatMap(name =>
    labels(name, ["the full file isn't available for this turn's edits", 3, 2, -4],
      ["the edit isn't applied yet", 3, 2, -4])),
  ...[diff + 'readFullFile', diff + 'toggleFold', diff + 'foldHints'].map(name =>
    argument(name, "the file isn't shown (", 1, 24, concat(3))),
  expression(diff + 'readFullFile', [
    format('%s is too large to load (%.1f MB; the limit is %d MB)', 24),
    [808, 816, 0, 1, '%s is too large to load (%.1f MB; the limit is %d MB)', 832],
  ]),
  ...formats(diff + 'readFullFile', ['%s is too large to load (%d lines; the limit is %d)', 24]),
  ...labels(diff + 'readFullFile', ['no file selected', 3]),
  argument(diff + 'readFullFile', "can't read ", 1, 8, concat(2), 2, -16),
  argument(diff + 'readFullFile', "can't find ", 1, 8, concat(3), 2, -28),
  argument(diff + 'readFullFile', ' on disk', 5, 24, concat(3)),
  argument(diff + 'readFullFile', "can't read ", 1, 8, concat(4), 2, -28),
  argument(diff + 'readFullFile', ' at ', 5, 24, concat(4)),
  ...['toggleFullFile', 'expandFold'].map(method =>
    argument(diff + method, 'file changed on disk since the diff was loaded', 3, 12, diff + 'setDetailNotice')),
  argument(diff + 'toggleFold', 'no folded lines in this file', 3, 12, diff + 'setDetailNotice'),
  rendered(diff + 'detailPositionLabel', 'file ', 3, 88),
  rendered(diff + 'detailPositionLabel', 'change ', 3, 88),
  ...formats(diff + 'searchPositionLabel', ['+%d hidden', 24]),
  ...['no matches', 'match ', 'wrapped'].map(text => rendered(diff + 'searchPositionLabel', text, 3, 80)),
  ...formats(diff + 'searchSummary', ['%d matches', 24], ['%d matches in %d files', 24]),
  ...labels(diff + 'searchSummary', ['no matches', 0], ['1 match', 0]),
  rendered(diff + 'searchPromptRow', '  Search:', 3, 88),
  rendered(diff + 'listSearchCount', ' 1 match ', 3, 80),
  ...formats(diff + 'listSearchCount', [' %d matches ', 24]),
  ...labels(diff + 'listHintBar', ['search', 8, 8, -48], ['clear search', 7, 7, -48]),

  ...['Edit hook', 'Add new hook'].map(text => argument(hooks + 'View', text, 0, 12, hooks + 'viewHookForm')),
  hookCount(hooks + 'viewTypeList'), hookCount(hooks + 'viewMatcherList'),
  argument(hooks + 'viewMatcherList', ' — Matchers', 3, 12, concat(2)),
  ...labels(hooks + 'viewMatcherList', ['+ Add new matcher...', 0], ['+ Match all (no filter)', 0], ['+ Add new hook...', 0]),
  argument(hooks + 'viewMatcherList', '  (workspace)', 3, 20, concat(2)),
  argument(hooks + 'viewMatcherList', '  (global)', 3, 12, concat(2)),
  argument(hooks + 'viewAddMatcher', 'Add new matcher for ', 1, 12, concat(2)),
  argument(hooks + 'viewHookForm', '  Event: ', 1, 24, concat(4)),
  argument(hooks + 'viewHookForm', '  Matcher: ', 1, 12, concat(2)),
  ...[['Name:', -36], ['Command:', -36], ['Timeout (seconds):', -40]].map(([text, distance]) =>
    argument(hooks + 'viewHookForm', text, 1, 8, hooks + 'writeFormField', 2, distance)),
  argument(hooks + 'viewHookForm', 'Switch field', 2, 12, hooks + 'newKeyHint'),
  ...formats(hooks + 'viewHookDetails', '  (timeout: %ds)'),
];
