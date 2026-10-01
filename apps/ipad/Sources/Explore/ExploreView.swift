import SwiftUI

struct ExploreView: View {
    let store: TappletStore

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var query = ""
    @State private var selectedSubjectID: String?
    @State private var selectedTopicID: String?
    @State private var selectedFormID: String?
    @State private var copyingProjectIDs: Set<String> = []
    @State private var preview: ArtifactProject?
    @State private var error: String?

    private var subjects: [ExampleCatalog.Subject] {
        ExampleCatalog.subjects(in: store.examples)
    }

    private var topics: [ExampleCatalog.Topic] {
        guard let selectedSubjectID else { return [] }
        return ExampleCatalog.topics(in: store.examples, subjectID: selectedSubjectID)
    }

    private var filteredProjects: [ArtifactProject] {
        ExampleCatalog.filteredProjects(
            store.examples,
            query: query,
            subjectID: selectedSubjectID,
            topicID: selectedTopicID,
            formID: selectedFormID
        )
    }

    private var hasActiveFilters: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || selectedSubjectID != nil
            || selectedTopicID != nil
            || selectedFormID != nil
    }

    private var columns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.adaptive(minimum: 310), spacing: 18)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeader(
                    title: "Start with an example",
                    subtitle: "Find a ready-made tapplet, preview it, then make a copy for your class.",
                    sticker: .greetings
                )

                if store.examples.isEmpty {
                    unavailableState
                } else {
                    let projects = filteredProjects
                    catalogControls
                    results(projects)
                }
            }
            .padding(32)
        }
        .onChange(of: selectedSubjectID) {
            selectedTopicID = nil
        }
        .fullScreenCover(item: $preview) { project in
            StudentPreviewView(
                project: project,
                onUsePlan: StarterPlan.matching(exampleID: project.artifact.id).map { plan in
                    { store.applyStarterPlan(plan) }
                }
            )
        }
        .alert(
            "Could not make a copy",
            isPresented: Binding(
                get: { error != nil },
                set: { if !$0 { error = nil } }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(error ?? "")
        }
    }

    private var catalogControls: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(TappletTheme.mutedInk)
                    .accessibilityHidden(true)
                TextField("Search title, subject, topic, or level", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityLabel("Search examples")
                    .accessibilityIdentifier("example-search")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(TappletTheme.mutedInk)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(minHeight: 54)
            .background(TappletTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(TappletTheme.border, lineWidth: 1)
            }

            filterGroup(title: "Form") {
                CatalogFilterPill(
                    title: "All",
                    group: "Form",
                    isSelected: selectedFormID == nil,
                    accessibilityIdentifier: "form-filter-all"
                ) {
                    selectedFormID = nil
                }
                CatalogFilterPill(
                    title: "Games",
                    group: "Form",
                    isSelected: selectedFormID == "game",
                    accessibilityIdentifier: "form-filter-game"
                ) {
                    selectedFormID = "game"
                }
            }

            filterGroup(title: "Subject") {
                CatalogFilterPill(
                    title: "All",
                    group: "Subject",
                    isSelected: selectedSubjectID == nil,
                    accessibilityIdentifier: "subject-filter-all"
                ) {
                    selectedSubjectID = nil
                }
                ForEach(subjects) { subject in
                    CatalogFilterPill(
                        title: subject.title,
                        group: "Subject",
                        isSelected: selectedSubjectID == subject.id,
                        accessibilityIdentifier: "subject-filter-\(subject.id)"
                    ) {
                        selectedSubjectID = subject.id
                    }
                }
            }

            if !topics.isEmpty {
                filterGroup(title: "Topic") {
                    CatalogFilterPill(
                        title: "All topics",
                        group: "Topic",
                        isSelected: selectedTopicID == nil,
                        accessibilityIdentifier: "topic-filter-all"
                    ) {
                        selectedTopicID = nil
                    }
                    ForEach(topics) { topic in
                        CatalogFilterPill(
                            title: topic.title,
                            group: "Topic",
                            isSelected: selectedTopicID == topic.id,
                            accessibilityIdentifier: "topic-filter-\(topic.id)"
                        ) {
                            selectedTopicID = topic.id
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func filterGroup<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(TappletTheme.Typography.eyebrow)
                .foregroundStyle(TappletTheme.mutedInk)
            FlowLayout(spacing: 8) {
                content()
            }
        }
    }

    @ViewBuilder
    private func results(_ projects: [ArtifactProject]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            resultsHeader(count: projects.count)

            if projects.isEmpty {
                emptyResultsState
            } else {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                    ForEach(projects) { project in
                        let isCopying = copyingProjectIDs.contains(project.id)
                        AppletProjectCard(
                            project: project,
                            primaryTitle: "Preview",
                            onPrimary: { preview = project },
                            primaryIsDisabled: isCopying,
                            primaryAccessibilityHint: "Opens the activity in a full-screen student preview.",
                            secondaryTitle: isCopying ? "Making a copy…" : "Make a copy",
                            onSecondary: { makeCopy(of: project) },
                            secondaryIsLoading: isCopying,
                            secondaryAccessibilityHint: "Creates an editable copy and opens it."
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func resultsHeader(count: Int) -> some View {
        let resultCount = Text("\(count) \(count == 1 ? "example" : "examples")")
            .font(TappletTheme.Typography.section)
            .foregroundStyle(TappletTheme.ink)
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 10) {
                resultCount
                clearFiltersButton
            }
        } else {
            HStack {
                resultCount
                Spacer()
                clearFiltersButton
            }
        }
    }

    @ViewBuilder
    private var clearFiltersButton: some View {
        if hasActiveFilters {
            Button {
                clearFilters()
            } label: {
                Label("Clear search and filters", systemImage: "xmark.circle")
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TappletTheme.accent)
            .accessibilityIdentifier("clear-example-filters")
        }
    }

    private var emptyResultsState: some View {
        VStack(spacing: 14) {
            Image(systemName: "magnifyingglass")
                .font(.largeTitle)
                .foregroundStyle(TappletTheme.mutedInk)
                .accessibilityHidden(true)
            Text("No examples found")
                .font(TappletTheme.Typography.question)
                .foregroundStyle(TappletTheme.ink)
            Text("Try another search or clear your filters.")
                .foregroundStyle(TappletTheme.mutedInk)
                .multilineTextAlignment(.center)
            Button("Clear search and filters") {
                clearFilters()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 52)
    }

    private var unavailableState: some View {
        ContentUnavailableView {
            Label {
                Text("Examples are unavailable")
            } icon: {
                PressedAppletMark(size: 72, rotation: .degrees(8))
            }
        } description: {
            Text("Tapplet Studio could not load its bundled activities.")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 52)
    }

    private func makeCopy(of project: ArtifactProject) {
        guard copyingProjectIDs.insert(project.id).inserted else { return }
        Task {
            defer { copyingProjectIDs.remove(project.id) }
            do {
                try await store.remix(project)
            } catch {
                let presentation = store.present(error, during: .generation)
                self.error = presentation.requestsWorkshopAccess ? nil : presentation.message
            }
        }
    }

    private func clearFilters() {
        query = ""
        selectedSubjectID = nil
        selectedTopicID = nil
        selectedFormID = nil
    }
}

struct CatalogFilterPill: View {
    let title: String
    let group: String
    let isSelected: Bool
    let accessibilityIdentifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.bold())
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isSelected ? TappletTheme.filterSelection : TappletTheme.ink)
            .padding(.horizontal, 15)
            .frame(minHeight: 44)
            .background(
                isSelected ? TappletTheme.filterSelectionSoft : TappletTheme.surface,
                in: Capsule()
            )
            .overlay {
                Capsule()
                    .stroke(
                        isSelected ? TappletTheme.filterSelection.opacity(0.35) : TappletTheme.border,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(group), \(title)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}

struct ExampleCatalog {
    struct Subject: Identifiable, Equatable {
        let id: String
        let title: String
    }

    struct Topic: Identifiable, Equatable {
        let id: String
        let subjectID: String
        let title: String
        let tagKeys: Set<String>
    }

    private static let knownSubjects = [
        Subject(id: "mathematics", title: "Mathematics"),
        Subject(id: "science", title: "Science"),
        Subject(id: "english", title: "English"),
        Subject(id: "humanities", title: "Humanities"),
        Subject(id: "civics", title: "Civics"),
        Subject(id: "languages", title: "Languages"),
        Subject(id: "other", title: "Classroom"),
        Subject(id: "unspecified", title: "Other")
    ]

    private static let curatedTopics = [
        Topic(id: "fractions", subjectID: "mathematics", title: "Fractions", tagKeys: ["fractions", "equivalence"]),
        Topic(id: "geometry-measurement", subjectID: "mathematics", title: "Geometry & measurement", tagKeys: ["perimeter", "rectangles"]),
        Topic(id: "algebra", subjectID: "mathematics", title: "Algebra", tagKeys: ["algebra", "linear functions"]),
        Topic(id: "times-tables", subjectID: "mathematics", title: "Times tables", tagKeys: ["times tables", "multiplication", "fluency"]),
        Topic(id: "graphs", subjectID: "mathematics", title: "Graphs", tagKeys: ["graphs"]),
        Topic(id: "averages", subjectID: "mathematics", title: "Averages", tagKeys: ["mean", "median", "data"]),
        Topic(id: "scientific-inquiry", subjectID: "science", title: "Scientific inquiry", tagKeys: ["science inquiry", "variables", "fair test"]),
        Topic(id: "biology", subjectID: "science", title: "Biology", tagKeys: ["biology", "cells", "organelles"]),
        Topic(id: "light", subjectID: "science", title: "Light", tagKeys: ["light", "shadows", "prediction"]),
        Topic(id: "electricity", subjectID: "science", title: "Electricity", tagKeys: ["electricity", "conductors", "insulators"]),
        Topic(id: "writing", subjectID: "english", title: "Writing", tagKeys: ["writing", "paragraphs", "cohesion"]),
        Topic(id: "persuasion", subjectID: "english", title: "Persuasion", tagKeys: ["persuasion", "rhetoric", "audience"]),
        Topic(id: "editing", subjectID: "english", title: "Editing", tagKeys: ["editing", "concision", "word choice"]),
        Topic(id: "spelling", subjectID: "english", title: "Spelling", tagKeys: ["spelling", "vocabulary"]),
        Topic(id: "geography", subjectID: "humanities", title: "Geography", tagKeys: ["geography", "urban flooding", "fieldwork"]),
        Topic(id: "history-sources", subjectID: "humanities", title: "History & sources", tagKeys: ["history", "sources", "corroboration"]),
        Topic(id: "civic-budget", subjectID: "civics", title: "Budgets & trade-offs", tagKeys: ["civics", "budgets", "trade offs"])
    ]

    static func subjects(in projects: [ArtifactProject]) -> [Subject] {
        let representedIDs = Set(projects.map(subjectID(for:)))
        let known = knownSubjects.filter { representedIDs.contains($0.id) }
        let knownIDs = Set(knownSubjects.map(\.id))
        let unknown = representedIDs
            .subtracting(knownIDs)
            .map { Subject(id: $0, title: displayName($0)) }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        return known + unknown
    }

    static func topics(in projects: [ArtifactProject], subjectID: String) -> [Topic] {
        let subjectProjects = projects.filter { self.subjectID(for: $0) == subjectID }
        return curatedTopics.filter { topic in
            topic.subjectID == subjectID
                && subjectProjects.contains { matches($0, topic: topic) }
        }
    }

    static func filteredProjects(
        _ projects: [ArtifactProject],
        query: String,
        subjectID: String?,
        topicID: String?,
        formID: String? = nil
    ) -> [ArtifactProject] {
        let terms = normalize(query).split(whereSeparator: \.isWhitespace)
        let selectedTopic = topicID.flatMap { id in curatedTopics.first { $0.id == id } }
        guard topicID == nil || selectedTopic != nil else { return [] }

        return projects.filter { project in
            if let subjectID, self.subjectID(for: project) != subjectID {
                return false
            }
            if let selectedTopic, !matches(project, topic: selectedTopic) {
                return false
            }
            if let formID, !matchesForm(project, formID: formID) {
                return false
            }
            guard !terms.isEmpty else { return true }
            let searchableText = searchText(for: project)
            return terms.allSatisfy { searchableText.contains($0) }
        }
    }

    private static func subjectID(for project: ArtifactProject) -> String {
        guard let subject = project.artifact.subject else { return "unspecified" }
        let normalized = normalize(subject)
        return normalized.isEmpty ? "unspecified" : normalized
    }

    private static func matches(_ project: ArtifactProject, topic: Topic) -> Bool {
        let tags = Set(project.artifact.tags.map(normalize))
        return !tags.isDisjoint(with: topic.tagKeys)
    }

    private static func matchesForm(_ project: ArtifactProject, formID: String) -> Bool {
        if let form = project.artifact.form, !form.isEmpty {
            return normalize(form) == normalize(formID)
        }
        return project.artifact.tags.map(normalize).contains(normalize(formID))
    }

    private static func searchText(for project: ArtifactProject) -> String {
        let artifact = project.artifact
        let topicTitles = curatedTopics
            .filter { $0.subjectID == subjectID(for: project) && matches(project, topic: $0) }
            .map(\.title)
            .joined(separator: " ")
        return normalize([
            artifact.title,
            artifact.summary,
            artifact.learningObjective ?? "",
            subjectTitle(for: subjectID(for: project)),
            displayName(artifact.level ?? ""),
            topicTitles,
            artifact.tags.joined(separator: " ")
        ].joined(separator: " "))
    }

    private static func subjectTitle(for id: String) -> String {
        knownSubjects.first { $0.id == id }?.title ?? displayName(id)
    }

    private static func displayName(_ value: String) -> String {
        normalize(value).capitalized
    }

    private static func normalize(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}
