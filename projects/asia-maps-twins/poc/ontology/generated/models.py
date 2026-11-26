from __future__ import annotations

import re
import sys
from datetime import (
    date,
    datetime,
    time
)
from decimal import Decimal
from enum import Enum
from typing import (
    Any,
    ClassVar,
    Literal,
    Optional,
    Union
)

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    SerializationInfo,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer
)


metamodel_version = "1.12.0"
version = "None"


class ConfiguredBaseModel(BaseModel):
    model_config = ConfigDict(
        serialize_by_alias = True,
        validate_by_name = True,
        validate_assignment = True,
        validate_default = True,
        extra = "forbid",
        arbitrary_types_allowed = True,
        use_enum_values = True,
        strict = False,
    )





class LinkMLMeta(RootModel):
    root: dict[str, Any] = {}
    model_config = ConfigDict(frozen=True)

    def __getattr__(self, key:str):
        return getattr(self.root, key)

    def __getitem__(self, key:str):
        return self.root[key]

    def __setitem__(self, key:str, value):
        self.root[key] = value

    def __contains__(self, key:str) -> bool:
        return key in self.root


linkml_meta = LinkMLMeta({'default_prefix': 'bds',
     'default_range': 'string',
     'description': 'Lớp ngữ nghĩa của ontology: object type, interface (mixin), '
                    'link type, enum. Lớp hành động (action, function) nằm trong '
                    'kinetic.yaml. Quy ước lưu trữ đọc từ annotation `storage`: '
                    'versioned (có phiên bản theo thời gian hiệu lực) hoặc event '
                    '(append-only).',
     'id': 'https://example.org/bds/ontology',
     'imports': ['linkml:types'],
     'name': 'bds',
     'prefixes': {'bds': {'prefix_prefix': 'bds',
                          'prefix_reference': 'https://example.org/bds/ontology/'},
                  'linkml': {'prefix_prefix': 'linkml',
                             'prefix_reference': 'https://w3id.org/linkml/'}},
     'source_file': 'ontology/bds.yaml',
     'title': 'Bản đồ số — ontology v0 (PoC)',
     'types': {'MultiPolygonWKT': {'annotations': {'postgis': {'tag': 'postgis',
                                                               'value': 'geometry(MultiPolygon,4326)'}},
                                   'description': 'Đa giác ở dạng WKT, hệ toạ độ '
                                                  'WGS84.',
                                   'from_schema': 'https://example.org/bds/ontology',
                                   'name': 'MultiPolygonWKT',
                                   'typeof': 'string'},
               'PointWKT': {'annotations': {'postgis': {'tag': 'postgis',
                                                        'value': 'geometry(Point,4326)'}},
                            'description': 'Điểm ở dạng WKT, hệ toạ độ WGS84.',
                            'from_schema': 'https://example.org/bds/ontology',
                            'name': 'PointWKT',
                            'typeof': 'string'}}} )

class DataClass(str, Enum):
    public = "public"
    """
    Dữ liệu công khai được
    """
    internal = "internal"
    """
    Dữ liệu nội bộ tổ chức
    """
    personal = "personal"
    """
    Dữ liệu cá nhân
    """


class OrgType(str, Enum):
    carrier = "carrier"
    government = "government"
    community = "community"


class FacilityType(str, Enum):
    post_office = "post_office"
    """
    Bưu cục
    """
    agent = "agent"
    """
    Đại lý
    """
    hub = "hub"
    """
    Trung tâm khai thác / hub
    """
    warehouse = "warehouse"
    """
    Kho
    """
    pickup_point = "pickup_point"
    """
    Điểm gửi nhận
    """
    locker = "locker"
    """
    Tủ khoá
    """


class EventType(str, Enum):
    accepted = "accepted"
    """
    Nhận hàng từ người gửi
    """
    arrived = "arrived"
    """
    Đến điểm
    """
    sorted = "sorted"
    """
    Đã khai thác tại điểm
    """
    departed = "departed"
    """
    Rời điểm
    """
    out_for_delivery = "out_for_delivery"
    """
    Giao bưu tá đi phát
    """
    delivered = "delivered"
    """
    Phát thành công
    """
    failed = "failed"
    """
    Phát thất bại
    """
    returned = "returned"
    """
    Chuyển hoàn
    """


class FacilityLinkType(str, Enum):
    linehaul_to = "linehaul_to"
    """
    Trung chuyển tới
    """



class Record(ConfiguredBaseModel):
    """
    Mọi object có phiên bản theo thời gian hiệu lực.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'abstract': True,
         'annotations': {'storage': {'tag': 'storage', 'value': 'versioned'}},
         'from_schema': 'https://example.org/bds/ontology'})

    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class NetworkNode(ConfiguredBaseModel):
    """
    Interface cho mọi điểm thuộc mạng lưới vận hành.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology', 'mixin': True})

    code: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'AdminUnit']} })
    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    location: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode']} })
    operated_by: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode']} })


class Place(ConfiguredBaseModel):
    """
    Interface cho mọi vùng có tên và ranh giới.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology', 'mixin': True})

    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    boundary: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['Place']} })


class AdminUnit(Place, Record):
    """
    Đơn vị hành chính (mô hình 2 cấp).
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology', 'mixins': ['Place']})

    code: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'AdminUnit']} })
    level: int = Field(default=..., description="""1 = tỉnh/thành, 2 = xã/phường/đặc khu (mô hình 2 cấp).""", ge=1, le=2, json_schema_extra = { "linkml_meta": {'domain_of': ['AdminUnit']} })
    parent: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['AdminUnit']} })
    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    boundary: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['Place']} })
    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class Organization(Record):
    """
    Tổ chức vận hành hoặc sở hữu điểm mạng lưới (hãng, cơ quan, cộng đồng).
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology'})

    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    org_type: OrgType = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Organization']} })
    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class Facility(NetworkNode, Record):
    """
    Bưu cục, đại lý, hub, kho, điểm gửi nhận, tủ khoá.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology', 'mixins': ['NetworkNode']})

    facility_type: FacilityType = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Facility']} })
    in_admin_unit: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Facility']} })
    code: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'AdminUnit']} })
    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    location: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode']} })
    operated_by: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode']} })
    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class ServiceZone(Place, Record):
    """
    Vùng phục vụ của một điểm mạng lưới.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'from_schema': 'https://example.org/bds/ontology', 'mixins': ['Place']})

    served_by: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['ServiceZone']} })
    name: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['NetworkNode', 'Place', 'Organization']} })
    boundary: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['Place']} })
    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class FacilityLink(Record):
    """
    Liên kết giữa hai điểm mạng lưới (ví dụ tuyến trung chuyển).
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'annotations': {'kind': {'tag': 'kind', 'value': 'link'}},
         'from_schema': 'https://example.org/bds/ontology'})

    from_facility: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['FacilityLink']} })
    to_facility: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['FacilityLink']} })
    link_type: FacilityLinkType = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['FacilityLink']} })
    entity_id: str = Field(default=..., description="""ID thực thể ổn định (UUID), giữ nguyên qua mọi phiên bản.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    confidence: Optional[float] = Field(default=None, ge=0, le=1, json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_from: date = Field(default=..., description="""Ngày bắt đầu hiệu lực ngoài đời.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    valid_to: Optional[date] = Field(default=None, description="""Ngày hết hiệu lực (không tính). Trống nghĩa là đang hiệu lực.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    license: Optional[str] = Field(default=None, description="""Giấy phép của nguồn dữ liệu (OSM, Overture, nội bộ).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record']} })


class ShipmentEvent(ConfiguredBaseModel):
    """
    Sự kiện vận hành của một đơn, theo khung GS1 EPCIS rút gọn.
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'annotations': {'partition_by': {'tag': 'partition_by', 'value': 'ts'},
                         'storage': {'tag': 'storage', 'value': 'event'}},
         'from_schema': 'https://example.org/bds/ontology'})

    event_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    shipment_ref: str = Field(default=..., description="""Mã đơn đã băm HMAC có khoá; không bao giờ là mã gốc.""", json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    event_type: EventType = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    facility: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    ts: datetime  = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    reason_code: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['ShipmentEvent']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })


class Observation(ConfiguredBaseModel):
    """
    Một giá trị đo của một biến trên một thực thể vào một ngày (kiểu Data Commons).
    """
    linkml_meta: ClassVar[LinkMLMeta] = LinkMLMeta({'annotations': {'storage': {'tag': 'storage', 'value': 'event'}},
         'from_schema': 'https://example.org/bds/ontology'})

    observation_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    subject: str = Field(default=..., description="""Thực thể được đo (bưu cục, xã, tỉnh...).""", json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    variable: str = Field(default=..., description="""Tên biến thống kê, ví dụ daily_inbound, population.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    obs_date: date = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    value: float = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    unit: Optional[str] = Field(default=None, json_schema_extra = { "linkml_meta": {'domain_of': ['Observation']} })
    source: str = Field(default=..., description="""Hệ thống hoặc tập dữ liệu nguồn của bản ghi.""", json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    tenant_id: str = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })
    data_class: DataClass = Field(default=..., json_schema_extra = { "linkml_meta": {'domain_of': ['Record', 'ShipmentEvent', 'Observation']} })


# Model rebuild
# see https://pydantic-docs.helpmanual.io/usage/models/#rebuilding-a-model
Record.model_rebuild()
NetworkNode.model_rebuild()
Place.model_rebuild()
AdminUnit.model_rebuild()
Organization.model_rebuild()
Facility.model_rebuild()
ServiceZone.model_rebuild()
FacilityLink.model_rebuild()
ShipmentEvent.model_rebuild()
Observation.model_rebuild()
