package config

// Limits: con số vận hành của account-access, drive-backup-sync, classification-rules, hs-suggest, ai-correction-log và
// tariff-apply, khớp contracts/limits.json (TestLimitsMatchContract). Còn ⚠ Chạy thử (OQ-1, OQ-3) nên chỉ đổi ở contracts/limits.json rồi sửa đây cho khớp.
type Limits struct {
	LockoutMaxFailures         int
	LockoutWindowMinutes       int
	LockoutMinutes             int
	SessionHours               int
	OfflineHours               int
	OfflineLoginMaxFailures    int
	TempPasswordHours          int
	RevocationHeartbeatMinutes int
	// RevocationWindowMinutes: hạn tối đa để khoá/hạ quyền/thu hồi có hiệu lực trên máy có mạng (NFR-005); quá mức này là máy đã mất mạng.
	RevocationWindowMinutes int
	LicenseRefreshHours     int
	PasswordMinLength       int
	WebSessionTouchSeconds  int

	// drive-backup-sync.
	SyncPushSeconds              int
	SyncPullMinutes              int
	BootstrapRecentMonths        int
	StaleDeviceHours             int
	DriveDropAlertPercent        int
	DriveDropAlertMinItems       int
	LicenseUnreachableAlertHours int

	// classification-rules.
	RulesAiBudgetPercent        int
	RulesDupCheckTimeoutSeconds int
	RulesTestMaxExamples        int
	RulesTestSampleItems        int

	// hs-suggest: ngưỡng của thẻ hàng, AI và ngân sách.
	SuggestConfidencePercent     int
	SuggestMaxImages             int
	SuggestMaxImageBytes         int
	SuggestAiTimeoutSeconds      int
	SuggestOverloadRetries       int
	SuggestOverloadWindowSeconds int
	SuggestStoreLookupSeconds    int
	SuggestQuestionMaxChars      int
	SuggestNameMaxChars          int
	SuggestOldResultMonths       int
	AIBudgetWarnPercent          int
	AIBudgetOverrunPercent       int
	AIInvoiceAlertPercent        int
	SuggestAiConcurrency         int
	SuggestImageMaxEdgePx        int
	SuggestImageJpegQuality      int
	SuggestEstimateVndPerImage   int
	SuggestEstimateVndBase       int
	PresenceIdleMinutes          int
	PresenceHeartbeatSeconds     int
	PresencePollSeconds          int
	LessonCandidateMax           int
	LessonSendMax                int
	LessonCheckTimeoutSeconds    int
	LessonRecheckMinutes         int
	LessonPairMinCount           int
	LessonPairWindowDays         int
	LessonNoteMaxChars           int
	// ai-correction-log (Sổ dạy AI): nhắc rà soát, khoảng ngưỡng cặp, Khối gợi ý, trang Sổ, nhãn lý do.
	LessonReviewReminderHours int
	LessonPairCountMin        int
	LessonPairCountMax        int
	LessonPairDaysMin         int
	LessonPairDaysMax         int
	LessonBlockSimilarShown   int
	LessonBlockSimilarMax     int
	LessonListPageSize        int
	LessonReasonLabelMaxChars int

	// tariff-apply: biểu thuế (E-029 dùng lại StaleDeviceHours).
	TariffBasisMaxChars         int
	TariffManualMaxPercent      int
	TariffAntiDumpingMaxPercent int
	TariffManualMaxDecimals     int
	TariffNumberMaxDecimals     int
	TariffPreviewErrorRows      int
	TariffErrorRowAlertPercent  int
	TariffValidCodesMinPercent  int
	TariffUpcomingDays          int
	TariffStaleDays             int
	TariffNextYearReminderMonth int
	TariffNextYearReminderDay   int
	TariffApplyDateMinYear      int
	TariffApplyDateMaxDaysAhead int
	TariffVatReducedUntil       int
	TariffHeaderScanRows        int
	TariffHeaderMinMatches      int
	TariffAntiDumpingPrefixMin  int
	TariffAntiDumpingPrefixMax  int
	TariffMaxFileBytes          int

	// vipo-sheet-exchange.
	VipoBatchMaxRows          int
	VipoManualReadMinSeconds  int
	VipoAutoReadMinutes       int
	VipoAutoReadJitterSeconds int
	VipoBackoffMinutes        [2]int
	VipoCopyCheckMaxMinutes   int
	VipoAbnormalDropPercent   int
	VipoGoneAfterReads        int
	VipoPriceDeviationPercent string
	VipoNoteMaxChars          int
	VipoHeaderRowsDefault     int
	VipoMappingTailRows       int
	VipoWorkdayStart          string
	VipoWorkdayEnd            string
	VipoTwinManagerMinutes    int

	// ai-accuracy-report.
	AccuracyWeeks                 int
	AccuracyCasesWeeks            int
	AccuracyCasesMax              int
	AccuracyOtherReasonMaxPercent int
	// lot-merge.
	LotNameMaxChars            int
	LotManualReadMinSeconds    int
	LotOpenCheckMinutes        int
	LotBackoffSeconds          [2]int
	LotQuotePullTimeoutSeconds int
	// history-import.
	HistoryMaxFileBytes    int
	HistoryRefsMax         int
	HistoryPreviewPageRows int
}

var AccountLimits = Limits{
	LockoutMaxFailures:         10,
	LockoutWindowMinutes:       15,
	LockoutMinutes:             15,
	SessionHours:               12,
	OfflineHours:               168,
	OfflineLoginMaxFailures:    10,
	TempPasswordHours:          72,
	RevocationHeartbeatMinutes: 5,
	RevocationWindowMinutes:    15,
	LicenseRefreshHours:        6,
	PasswordMinLength:          8,
	WebSessionTouchSeconds:     60,

	SyncPushSeconds:              30,
	SyncPullMinutes:              15,
	BootstrapRecentMonths:        3,
	StaleDeviceHours:             24,
	DriveDropAlertPercent:        10,
	DriveDropAlertMinItems:       20,
	LicenseUnreachableAlertHours: 24,

	RulesAiBudgetPercent:        20,
	RulesDupCheckTimeoutSeconds: 30,
	RulesTestMaxExamples:        20,
	RulesTestSampleItems:        20,

	SuggestConfidencePercent:     80,
	SuggestMaxImages:             10,
	SuggestMaxImageBytes:         10485760,
	SuggestAiTimeoutSeconds:      120,
	SuggestOverloadRetries:       3,
	SuggestOverloadWindowSeconds: 300,
	SuggestStoreLookupSeconds:    30,
	SuggestQuestionMaxChars:      1000,
	SuggestNameMaxChars:          200,
	SuggestOldResultMonths:       12,
	AIBudgetWarnPercent:          20,
	AIBudgetOverrunPercent:       5,
	AIInvoiceAlertPercent:        10,
	SuggestAiConcurrency:         4,
	SuggestImageMaxEdgePx:        1600,
	SuggestImageJpegQuality:      80,
	SuggestEstimateVndPerImage:   60,
	SuggestEstimateVndBase:       40,
	PresenceIdleMinutes:          30,
	PresenceHeartbeatSeconds:     60,
	PresencePollSeconds:          30,
	LessonCandidateMax:           30,
	LessonSendMax:                10,
	LessonCheckTimeoutSeconds:    5,
	LessonRecheckMinutes:         15,
	LessonPairMinCount:           3,
	LessonPairWindowDays:         90,
	LessonNoteMaxChars:           500,
	LessonReviewReminderHours:    168,
	LessonPairCountMin:           2,
	LessonPairCountMax:           20,
	LessonPairDaysMin:            30,
	LessonPairDaysMax:            365,
	LessonBlockSimilarShown:      3,
	LessonBlockSimilarMax:        10,
	LessonListPageSize:           200,
	LessonReasonLabelMaxChars:    100,

	TariffBasisMaxChars:         200,
	TariffManualMaxPercent:      100,
	TariffAntiDumpingMaxPercent: 1000,
	TariffManualMaxDecimals:     2,
	TariffNumberMaxDecimals:     3,
	TariffPreviewErrorRows:      100,
	TariffErrorRowAlertPercent:  5,
	TariffValidCodesMinPercent:  50,
	TariffUpcomingDays:          365,
	TariffStaleDays:             183,
	TariffNextYearReminderMonth: 12,
	TariffNextYearReminderDay:   1,
	TariffApplyDateMinYear:      2020,
	TariffApplyDateMaxDaysAhead: 366,
	TariffVatReducedUntil:       20261231,
	TariffHeaderScanRows:        10,
	TariffHeaderMinMatches:      3,
	TariffAntiDumpingPrefixMin:  4,
	TariffAntiDumpingPrefixMax:  8,
	TariffMaxFileBytes:          67108864,

	VipoBatchMaxRows:          200,
	VipoManualReadMinSeconds:  60,
	VipoAutoReadMinutes:       15,
	VipoAutoReadJitterSeconds: 60,
	VipoBackoffMinutes:        [2]int{30, 60},
	VipoCopyCheckMaxMinutes:   10,
	VipoAbnormalDropPercent:   5,
	VipoGoneAfterReads:        2,
	VipoPriceDeviationPercent: "2.00",
	VipoNoteMaxChars:          50000,
	VipoHeaderRowsDefault:     1,
	VipoMappingTailRows:       5,
	VipoWorkdayStart:          "08:15",
	VipoWorkdayEnd:            "17:00",
	VipoTwinManagerMinutes:    10,

	AccuracyWeeks:                 12,
	AccuracyCasesWeeks:            4,
	AccuracyCasesMax:              300,
	AccuracyOtherReasonMaxPercent: 10,
	LotNameMaxChars:               200,
	LotManualReadMinSeconds:       60,
	LotOpenCheckMinutes:           15,
	LotBackoffSeconds:             [2]int{30, 60},
	LotQuotePullTimeoutSeconds:    20,
	HistoryMaxFileBytes:           67108864,
	HistoryRefsMax:                5,
	HistoryPreviewPageRows:        50,
}
