/* Sample-scoped fixtures for the non-Clerk approval demo. */
export interface DemoApprovalSample {
  sampleCode: string;
  requestCode: string;
  productName: string;
  status: "SUBMITTED" | "REVIEWED";
  version: number;
  parameters: {
    code: string;
    name: string;
    result: string;
    unit: string;
    method: string;
  }[];
  history: { version: number; comment: string }[];
}

export const APPROVAL_SAMPLES: DemoApprovalSample[] = [
  {
    sampleCode: "2610001201",
    requestCode: "26100012",
    productName: "Sầu riêng",
    status: "REVIEWED",
    version: 2,
    parameters: [
      {
        code: "HM",
        name: "Cadmium (Cd)",
        result: "20.0",
        unit: "µg/kg",
        method: "HD.H.01 (2026) (Ref. AOAC 2015.01)",
      },
      {
        code: "VO",
        name: "Auramine O",
        result: "Skin: ND · Flesh: ND",
        unit: "µg/kg",
        method: "HD.H.101 (2026) (Ref. BJS 202204)",
      },
    ],
    history: [
      { version: 2, comment: "Gửi lại và đã qua kiểm tra kỹ thuật." },
      { version: 1, comment: "Trả lại để sửa đơn vị mg/kg thành µg/kg." },
    ],
  },
  {
    sampleCode: "2610001202",
    requestCode: "26100012",
    productName: "Sầu riêng",
    status: "SUBMITTED",
    version: 1,
    parameters: [
      {
        code: "HM",
        name: "Cadmium (Cd)",
        result: "12.4",
        unit: "µg/kg",
        method: "HD.H.01 (2026) (Ref. AOAC 2015.01)",
      },
    ],
    history: [{ version: 1, comment: "Đã gửi mẫu, đang chờ kiểm tra kỹ thuật." }],
  },
  {
    sampleCode: "2610000701",
    requestCode: "26100007",
    productName: "Thanh long",
    status: "REVIEWED",
    version: 1,
    parameters: [
      {
        code: "VO",
        name: "Auramine O",
        result: "Skin: ND · Flesh: ND",
        unit: "µg/kg",
        method: "HD.H.101 (2026) (Ref. BJS 202204)",
      },
    ],
    history: [{ version: 1, comment: "Đã qua kiểm tra kỹ thuật." }],
  },
];
