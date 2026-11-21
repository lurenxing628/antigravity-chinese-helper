import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const detail = 'ArtifactDetailModel.', artifacts = 'ArtifactViewModel.';
const search = 'CodeSearchModel.RenderHeader', live = 'LiveCodeSearchModel.View';
const card = '(*btwModel).renderCard';
const lipgloss = 'google3/third_party/golang/charm_land/lipgloss/v/v2/lipgloss.';
const artifactOutput = 'google3/third_party/jetski/cli/store/store.(*Manager).addCommandOutputWith';

const formats = (method, ...texts) => ({name:model + method, optional:true, formats:texts});
const group = (method, literals, verifiedCalls = []) => ({
  name:model + method, optional:true, resolve:relocateStatusLiteralGroup, literals, verifiedCalls,
});

// All strings belong to a panel's display expression. A repeated phrase is
// anchored together with its other occurrence so both UI branches are updated.
export const cliArtifactPanelLiteralProfiles = [
  formats(detail + 'updateInner', 'Editor %q failed: %v'),
  formats(detail + 'openEditor', 'Failed to open editor: %v'),
  formats(artifacts + 'Update.func1', 'Failed to open editor %q: %v. Set $EDITOR or use /settings to configure.'),
  // The confirmation model returns its captions separately from the callbacks.
  formats(detail + 'getConfirmation', 'You have %d unsent comment(s). Send to agent?'),
  group(detail + 'getConfirmation', [[0, 8, 1, 2, 'send + close'], [16, 24, 1, 2, 'discard + close']]),
  group(detail + 'getConfirmation', [
    [0, 8, 3, 4, 'Comments will be discarded if you modify the artifact. Open editor?'],
    [16, 24, 3, 4, 'open editor'], [32, 40, 3, 4, 'cancel'],
  ]),
  group(detail + 'cycleMermaidSubject', [[0, 8, 0, 1, 'diagram'], [24, 32, 0, 1, 'math']]),
  ...[' source', ' ASCII', ' image'].map(text => group(detail + 'cycleMermaidHintAction',
    [[0, 8, 3, 4, text]], [[20, 'runtime.concatstring2']])),
  group(detail + 'cycleMermaidHintAction', [[0, 8, 0, 1, 'unknown mode']]),
  formats(detail + 'renderLoadingOrErrorView', 'Rendering diagrams & math (%s)…'),
  group(detail + 'renderLoadingOrErrorView', [
    [0, -4, 2, 1, 'image mode'], [24, 20, 2, 1, 'ASCII mode'],
    [48, 44, 2, 1, 'raw mode'], [64, 60, 2, 1, 'unknown mode'],
  ]),
  ...['renderHeader', 'renderOutlineView'].map(method =>
    group(detail + method, [[0, -8, 8, 9, 'Artifact']])),
  formats(detail + 'renderFooter', 'zoom %d%%', 'next/prev (%q)', '  Comment (L%d):'),
  group(detail + 'renderFooter', [[0, 8, 5, 6, '  Search:']],
    [[84, lipgloss + 'Style.Render']]),
  group('artifactSearchInputWidth', [[0, 8, 0, 1, '  Search: / ']], [[12, lipgloss + 'Width']]),
  group(detail + 'renderOutlineView', [[0, 8, 5, 6, ' — Outline ']], [[12, 'runtime.concatstring3']]),
  // The turn is sent before this separate command output is assembled.
  group(detail + 'dismiss.func1', [[0, 8, 1, 2, 'Comments on '], [20, 28, 5, 6, ':\n', undefined, 'cli-artifact-status:']],
    [[-8, 'google3/third_party/jetski/cli/store/store.(*Manager).handleUserInput'], [40, 'runtime.concatstring4'],
      [116, artifactOutput]]),
  formats(artifacts + 'renderFilePreview', '  ... %d more lines'),
  formats(artifacts + 'RenderHeader', 'Action required (%d left)'),
  formats(artifacts + 'View', 'Media · %d items (enter to expand)'),
  ...[
    ['submitAndExit.func1', 'Review submitted', 12, 24],
    ['viewReadOnly.func1', "Media from a remote agent can't be opened here yet", 2, 20],
  ].map(([method, text, register, call]) => group(artifacts + method,
    [[0, 8, register, register + 1, text]],
    [[call, artifactOutput]])),
  group('ArtifactReviewModel.StatusLine', [
    [0, -12, 2, 1, 'artifact', undefined, 'cli-artifact-status:'],
    [8, -8, 3, 2, 'artifacts', undefined, 'cli-artifact-status:'],
    [36, 44, 0, 1, '%d %s · /artifact to review', 60],
  ], [[20, 'runtime.convTstring']]),
  formats('AskQuestionModel.View', 'Question %d/%d: %s'),
  group('(*btwModel).hintText', [
    [0, 8, 5, 6, 'Tab to collapse'], [0x58, 0x38, 5, 5, 'Tab to expand'],
    [0xc4, 0xa4, 5, 5, '←/→ to navigate'], [0x130, 0x110, 6, 6, '/help <reply> to follow up'],
    [0x188, 0x168, 6, 6, 'Enter/Esc to dismiss'],
  ], [[0x1a4, 'strings.Join']]),
  formats(card, '↑/↓ to scroll (%d-%d of %d)'),
  group(card, [[0, 8, 0, 1, '%s %s... (Enter/Esc to cancel)', 28],
    [0x358, 0x360, 0, 1, '%s %s... (Enter/Esc to cancel)', 0x374]]),
  group(card, [[0, 8, 3, 4, ' Thinking... (Enter/Esc to cancel)']], [[12, 'runtime.concatstring2']]),
  group(card, [[0, 8, 5, 6, ' ended unexpectedly without a response']], [[24, 'runtime.concatstring3']]),
  group(card, [[0, 8, 4, 5, '... (truncated)']]),
  group(card, [[0, -16, 3, 3, 'Generating']], [[12, 'runtime.convTstring']]),
  group(card, [[0, -16, 1, 2, 'Warning: Markdown rendering failed: ']], [[8, 'runtime.concatstring2']]),
  group(card, [[0, 8, 1, 2, 'Error: ']], [[12, 'runtime.concatstring2']]),
  group(card, [[0, -28, 1, 2, 'Error: ']], [[8, 'runtime.concatstring3']]),
  group(search, [[0, -4, 3, 2, '1 result'], [44, 52, 0, 1, '%d results', 68],
    [0x18c, 0x188, 3, 2, '1 result'], [0x1b8, 0x1c0, 0, 1, '%d results', 0x1d0]]),
  formats(search, 'Searching… (%s so far)'),
  group(search, [[0, 12, 1, 2, 'Found ']]),
  ...[search, live].map(method => group(method, [[0, 8, 1, 2, '  Error: ']], [[12, 'runtime.concatstring2']])),
  formats(live, 'Searching for %q...'),
  group(live, [[0, -4, 3, 2, '(error)']]),
  group(live, [[0, -32, 7, 7, 'searching…']], [[40, 'strings.Join']]),
];
