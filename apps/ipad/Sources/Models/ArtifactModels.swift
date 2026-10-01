import Foundation

struct AdvisoryWarning: Codable, Equatable, Sendable {
    let source: String
    let code: String
    let message: String
    let categories: [String]?
}

struct AdvisoryResult<Value: Sendable>: Sendable {
    let value: Value
    let warnings: [AdvisoryWarning]
}

struct Artifact: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var summary: String
    var subject: String? = nil
    var level: String? = nil
    var locale: String? = nil
    var learningObjective: String? = nil
    var tags: [String]
    var creationBrief: String
    var headRevisionId: String
    var remixedFromRevisionId: String? = nil
    var createdAt: String
    var updatedAt: String
    var publication: ArtifactPublication? = nil
    var publicationStale: Bool? = nil
    var headRevision: ArtifactRevision? = nil
    var html: String? = nil
    var form: String? = nil
}

struct ArtifactRevision: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable { case generate, revise, remix, seed }
    var id: String
    var artifactId: String
    var parentRevisionId: String? = nil
    var sourceHash: String
    var byteLength: Int
    var kind: Kind
    var instruction: String? = nil
    var designCard: String? = nil
    var screenshotUrl: URL? = nil
    var model: String
    var promptVersion: String
    var createdAt: String
}

struct ArtifactSource: Codable, Equatable, Sendable {
    var revision: ArtifactRevision
    var html: String
}

struct ArtifactPublication: Codable, Equatable, Sendable {
    var slug: String
    var url: URL
    var title: String
    var createdAt: String
    var expiresAt: String
    var revokedAt: String? = nil

    var expirationDate: Date? {
        (try? Date(expiresAt, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(expiresAt, strategy: .iso8601))
    }
    func isExpired(at date: Date = .now) -> Bool { expirationDate.map { $0 <= date } ?? true }
    func formattedExpirationDate() -> String {
        guard let expirationDate else { return expiresAt }
        return expirationDate.formatted(date: .abbreviated, time: .omitted)
    }
}

struct ArtifactProject: Codable, Equatable, Identifiable, Sendable {
    var artifact: Artifact
    var source: ArtifactSource
    var revisions: [ArtifactRevision]
    var localAssets: [LocalAppletAssetFile] = []
    var isExample = false
    var id: String { artifact.id }
    var updatedAt: Date {
        (try? Date(artifact.updatedAt, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(artifact.updatedAt, strategy: .iso8601))
            ?? .distantPast
    }
}

struct ExampleArtifact: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var summary: String
    var subject: String? = nil
    var level: String? = nil
    var locale: String? = nil
    var learningObjective: String? = nil
    var tags: [String]
    var form: String? = nil
    var file: String

    enum CodingKeys: String, CodingKey {
        case id, title, summary, subject, level, locale, learningObjective, tags, form
        case file = "filename"
    }
}

struct ExampleManifest: Codable, Sendable {
    var schemaVersion: String
    var seeds: [ExampleArtifact]
}

struct ExampleSearchDescriptor: Codable, Equatable, Identifiable, Sendable {
    var artifactId: String
    var revisionId: String
    var title: String
    var descriptor: String
    var curated: Bool
    var id: String { revisionId }
}
