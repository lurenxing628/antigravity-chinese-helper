import { relocateStatusLiteralGroup } from './cli-panel-status-profiles.mjs';

const model = 'google3/third_party/jetski/cli/model/model.';
const projects = model + 'ProjectsModel.';
function group(name, literals, verifiedCalls = []) {
  return {name, optional:true, resolve:relocateStatusLiteralGroup, literals, verifiedCalls};
}
function string(method, text, pointer, length, distance, verifiedCalls) {
  return group(projects + method, [[0, distance, pointer, length, text]], verifiedCalls);
}

// Only displayed labels are localized. The selected row kind, provider ID,
// resource path and user-supplied project name stay in their own fields.
export const cliProjectPanelLiteralProfiles = [
  string('create', 'Creating ', 1, 2, -16, [[8, 'runtime.concatstring2']]),
  string('save', 'Saving ', 1, 2, -16, [[8, 'runtime.concatstring2']]),
  string('header', 'New Project', 3, 4, -4),
  ...['Folders', 'Connections'].map(title => ({
    ...group(projects + 'header', [
      [0, 8, 5, 2, 'Name', undefined, 'cli-project-tab:'], [20, 28, 5, 6, title],
    ]),
    resolve(buffer, metadata, profile) {
      const located = relocateStatusLiteralGroup(buffer, metadata, profile);
      // The first iteration also uses this length for its four-byte checkmark.
      return {...located, sharedLengths:[located.literals[0][1]]};
    },
  })),
  string('body', '(error)', 0, 1, -4),
  string('connectionsBody', "  Couldn't load connections: ", 1, 2, -16, [[8, 'runtime.concatstring2']]),
  ...['+ Add a local file...', '+ Add a folder...', '+ Add a Drive file by link...'].map(text =>
    string('connectionsBody', text, 13, 12, -4)),
  group(model + '(*projectEditor).rows', [[0, -12, 8, 5, 'No matching resources found.'], [8, -8, 9, 8, 'No resources found.']]),
  group(model + '(*ProjectsModel).validateName', [[0, -36, 1, 1, 'Enter a project name.']]),
  group(model + '(*ProjectsModel).validateName', [[0, -32, 1, 1, 'A project with this name already exists.']]),
  group(projects + 'exitPrompt', [[0, -12, 0, 0, 'Cancel project creation?'], [8, -8, 2, 1, 'Discard changes?']],
    [[20, 'runtime.convTstring']]),
  // fmt.Errorf has a fallback string for the nil-error branch.
  ...[[projects + 'Update', 'connecting %s: %w'], [model + '(*projectEditor).addLocalFolder', '%s is not a folder']]
    .map(([name, text]) => group(name, [[0, 8, 0, 1, text], [56, 64, 3, 4, text]], [[24, 'fmt.errorf']])),
];
