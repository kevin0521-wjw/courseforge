#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Android 发布签名库（PKCS12）。

为什么不用 keytool：本机没有 JDK，也不值得为一条命令装 190MB。
Python cryptography 的 PKCS12 等价于 keytool -genkeypair -storetype PKCS12，
Gradle 两种格式都认。

产物：android/app/courseforge.keystore（随仓库入库，密码明文写在 build.gradle ——
自发布 FOSS 应用的取舍，见 README「安卓安装包」一节）。
"""
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
import datetime

OUT = Path(__file__).resolve().parent.parent / "android" / "app" / "courseforge.keystore"

# RSA 2048 + SHA256，有效期 30 年（覆盖应用生命周期）
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = x509.Name([
    x509.NameAttribute(x509.NameOID.COMMON_NAME, u"CourseForge"),
    x509.NameAttribute(x509.NameOID.ORGANIZATION_NAME, u"CourseForge"),
])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(subject)  # 自签名
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now)
    .not_valid_after(now + datetime.timedelta(days=365 * 30))
    .sign(key, hashes.SHA256())
)

data = pkcs12.serialize_key_and_certificates(
    name=b"courseforge",
    key=key,
    cert=cert,
    cas=None,
    encryption_algorithm=serialization.BestAvailableEncryption(b"courseforge2026"),
)
OUT.write_bytes(data)
print("written:", OUT, len(data), "bytes")
