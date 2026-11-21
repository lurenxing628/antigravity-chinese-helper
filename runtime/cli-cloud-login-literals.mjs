const model = 'google3/third_party/jetski/cli/model/model.GcpSetupModel.';
const locations = 'For a full list of available locations and deployment endpoints, please refer to the official documentation: https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations';

// The profile resolver matches each expression inside its owning display function.
// Offsets are relative to the string producer; the login state and selected index
// are separate from these displayed strings.
function literal(method, text, pointer, length = pointer + 1, lengthOffset = 8, formatCall) {
  return {name:model + method, literals:[[0, lengthOffset, pointer, length, text, formatCall]]};
}

export const cloudLoginLiteralProfiles = [
  literal('renderFullView', 'Welcome to the ', 1, 2, -28),
  literal('renderFullView', '. You are currently not signed in.\n\n', 5),
  literal('renderFullView', 'Welcome back! You are currently not signed in.\n\n', 0, 1, -4),
  literal('renderFullView', 'Select Google Cloud sign-in method:\n', 0),
  literal('renderFullView', 'Choose region:\n', 3),
  literal('renderFullView', ' Fetching licenses...', 5),
  literal('renderFullView', ' Assigning license...', 5),
  literal('renderFullView', ' Signing in...', 5),
  // The same documentation link is rendered with or without wrapping.
  {name:model + 'renderFullView', literals:[[0, -4, 3, 2, locations], [24, 20, 3, 2, locations]]},
  literal('renderBillingModelSelectionMenu', 'Select billing model:\n', 0, 1, -8),
  literal('billingModelOptions', 'Subscriptions – Use %s through your Gemini subscription.', 0, 1, 8, 24),
  literal('billingModelOptions', 'Pay As You Go – Pay only for the tokens you use, billed through Gemini platform.', 3),
  literal('renderLicenseSelectionMenu', 'Verify that these licenses were provided by your administrator and that you trust the project ID before proceeding. Account activity and data may be logged by your organization.', 0),
  literal('renderLicenseSelectionMenu', "Can't find your subscription? Enter a Google Cloud project", 3, 5, -32),
  literal('renderLicenseSelectionMenu', 'Select available subscription:\n\n', 1, 2, -32),
  literal('renderSelfAssignLicenseMenu', 'Licenses are provided by your organization admin. Your Customer Data will be logged into the project that corresponds to the subscription you select below.', 0),
  literal('renderSelfAssignLicenseMenu', 'Select subscription:\n\n', 1, 2, -28),
  literal('renderSelfAssignLicenseMenu', 'No license available for this project and location. Contact your administrator to setup Gemini Enterprise for this project.', 0),
  literal('renderWIFInput', 'SSO Endpoint:\n\n', 1, 2, -16),
  literal('renderWIFInput', 'Enter the SSO URL provided by your IT admin to connect your work account', 3),
  literal('renderProjectInput', 'Your %s use will be associated with provided project.', 0, 1, 8, 28),
  literal('renderProjectInput', ' Make sure you trust the project ID before proceeding. Account activity and data may be logged by your organization.', 3),
  literal('renderProjectInput', 'Provide Google Cloud project:\n', 1, 2, -44),
];
