# Job Autofill Privacy Policy

Effective September 2, 2026

Job Autofill processes information only to help a user complete and organize their own job applications. Questions may be sent to `yaoz25@mcmaster.ca`.

## Data processed

- Resume files and extracted resume text.
- Name, address, phone number, email address, websites, education, employment history, languages, skills, availability, and saved application answers.
- The current tab URL, page title, visible job description, application questions, available choices, and limited surrounding page text.
- Optional sensitive answers chosen by the user, including demographic identity, disability, veteran status, sexual orientation, work authorization, legal disclosures, conflicts, and criminal-history information.
- Optional service credentials, including a Notion access token and AI-provider credentials kept by the local Docker backend.
- Application-history records and export preferences.

## Purposes and data flow

Data is used only to prefill application fields, produce truthful answer suggestions, attach a user-selected resume, and create application-history exports selected by the user. The extension does not sell personal data, use data for advertising, determine creditworthiness, or click final Submit.

Profile data, resume cache, settings, consent choices, and tokens are stored in the user's Chrome profile and optional Docker backend on the user's device. When cloud AI is enabled, the minimum relevant resume evidence, job description, page context, question labels, and available choices are sent to the configured AI provider. Saved sensitive answers are included only after separate sensitive-data consent. When Notion is enabled, the extension sends the selected application record and locally stored Notion token to Notion.

AI responses are treated only as untrusted semantic suggestions. They cannot supply selectors, scripts, event names, click instructions, wait times, navigation, or action sequences. Extension-packaged code independently locates fields, selects from available options, dispatches browser events, waits for widgets, verifies changes, and decides whether a completed page can advance.

## Sharing

Data is shared only with processors the user explicitly enables: the configured AI provider, Notion, and the application website the user chose to complete. No data is sold or transferred to data brokers, advertisers, or unrelated parties.

## Retention and deletion

Local data remains until the user changes it, removes the extension/browser profile, or selects **Delete all local data** in **Privacy & Data**. That control clears Chrome-local data and requests deletion of the backend profile and resume. Exported files and existing Notion pages remain under the user's control and must be deleted at their destination. AI-provider credentials stored in the companion backend configuration, environment, or operating-system keychain are managed separately by the user and are not removed by this control.

## User controls

The first-run screen requires local-processing consent and separately offers automatic site access, cloud AI, sensitive-answer AI matching, and Notion export. All optional choices can be changed or withdrawn in **Privacy & Data**. Automatic site access uses optional host permissions requested at runtime.

## Security

Cloud API keys stay in the local backend configuration and are not bundled with the extension. Notion tokens are stored locally. Network AI output is schema-validated and cannot execute code. Users must review all filled fields before submitting an application.
