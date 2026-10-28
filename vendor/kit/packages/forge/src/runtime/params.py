# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Iran Open Finance. Not derived from upstream Forge.
# OpenAPI 3.1 parameter serialization (style, explode, allowReserved; content-encoded parameters) for the generated
# Python client: the same rules as params.js, which the tests hold it to case for case. Inlined verbatim into every
# generated __init__.py (kit sdk generate). Combinations the specification leaves undefined are refused at generation.


def _text(value: Any) -> str:
    """A value as JavaScript's String() writes it (true, false, null, 2 for 2.0)."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _encode(value: Any, allow_reserved: bool = False) -> str:
    """Percent-encode; allowReserved keeps RFC 3986 reserved characters (query only)."""
    s = _text(value)
    if not allow_reserved:
        return urllib.parse.quote(s, safe="-_.~")
    s = urllib.parse.quote(s, safe="-._~:/?#[]@!$&'()*+,;=%")
    return re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", s)


def _kind(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "primitive"


def _pairs(value: dict) -> list:
    return [(k, x) for k, x in value.items() if x is not None]


def _serialize_param(p: dict, value: Any) -> dict:
    """One parameter value → {"path": str} | {"query": [str]} | {"header": str} | {"cookie": str}."""
    def enc(x: Any) -> str:
        return _encode(x, p.get("allowReserved", False))

    v = json.dumps(value, separators=(",", ":"), ensure_ascii=False) if p.get("json") else value
    kind = _kind(v)
    loc = p["in"]
    style = p.get("style")
    explode = p.get("explode", False)
    name = _encode(p["name"]) if loc in ("query", "cookie") else p["name"]
    if loc == "path":
        sep = ("." if explode else ",") if style == "label" else (";" if explode else ",") if style == "matrix" else ","
        prefix = "." if style == "label" else ""
        if kind == "primitive":
            body = f";{name}={enc(v)}" if style == "matrix" else f"{prefix}{enc(v)}"
        elif kind == "array":
            if style == "matrix":
                body = "".join(f";{name}={enc(x)}" for x in v) if explode else f";{name}=" + ",".join(enc(x) for x in v)
            else:
                body = prefix + sep.join(enc(x) for x in v)
        else:
            kv = _pairs(v)
            if style == "matrix":
                body = "".join(f";{enc(k)}={enc(x)}" for k, x in kv) if explode else f";{name}=" + ",".join(f"{enc(k)},{enc(x)}" for k, x in kv)
            else:
                body = prefix + (sep.join(f"{enc(k)}={enc(x)}" for k, x in kv) if explode else ",".join(f"{enc(k)},{enc(x)}" for k, x in kv))
        return {"path": body}
    if loc == "header":
        if kind == "primitive":
            return {"header": _text(v)}
        if kind == "array":
            return {"header": ",".join(_text(x) for x in v)}
        kv = _pairs(v)
        return {"header": ",".join(f"{_text(k)}={_text(x)}" if explode else f"{_text(k)},{_text(x)}" for k, x in kv)}
    if loc == "cookie":
        if kind == "primitive":
            return {"cookie": f"{name}={enc(v)}"}
        items = [enc(x) for x in v] if kind == "array" else [e for k, x in _pairs(v) for e in (enc(k), enc(x))]
        return {"cookie": f"{name}=" + ",".join(items)}
    style = style or "form"
    if kind == "primitive":
        return {"query": [f"{name}={enc(v)}"]}
    if style == "deepObject":
        return {"query": [f"{name}%5B{enc(k)}%5D={enc(x)}" for k, x in _pairs(v)]}
    sep = "%20" if style == "spaceDelimited" else "%7C" if style == "pipeDelimited" else ","
    if kind == "array":
        if explode:
            return {"query": [f"{name}={enc(x)}" for x in v]}
        return {"query": [f"{name}=" + sep.join(enc(x) for x in v)]}
    kv = _pairs(v)
    if explode:
        return {"query": [f"{enc(k)}={enc(x)}" for k, x in kv]}
    return {"query": [f"{name}=" + sep.join(f"{enc(k)}{sep}{enc(x)}" for k, x in kv)]}


def _serialize_params(operation_id: str, op: dict, params: Mapping[str, Any]) -> tuple:
    """Every parameter of an operation → (path, query, headers, cookie); a missing required one raises TypeError."""
    path = op["path"]
    query: list = []
    headers: dict = {}
    cookies: list = []
    for p in op["params"]:
        v = params.get(p["name"])
        if v is None:
            if p["required"]:
                raise TypeError(f'{operation_id}: missing required {p["in"]} parameter "{p["name"]}"')
            continue
        s = _serialize_param(p, v)
        if p["in"] == "path":
            path = path.replace("{" + p["name"] + "}", s["path"])
        elif p["in"] == "query":
            query.extend(s["query"])
        elif p["in"] == "header":
            headers[p["name"]] = s["header"]
        else:
            cookies.append(s["cookie"])
    return path, "&".join(query), headers, "; ".join(cookies)


def _is_json(content_type: str) -> bool:
    return re.match(r"application/(.+\+)?json\b", content_type or "", re.I) is not None


class Omitted:
    """The type of OMITTED: a body argument left out (None is JSON null when the body's schema admits null)."""

    def __repr__(self) -> str:
        return "OMITTED"


OMITTED = Omitted()


def _encode_body(operation_id: str, spec: dict, body: Any) -> tuple:
    """A request body by its declared media type → (bytes or None, content type or None), as encodeBody in params.js.

    OMITTED leaves the body out (a required body raises TypeError); None is JSON null when the schema admits null and
    the body is JSON, else it is left out too. A JSON media type (or none declared) is json.dumps'd, a str included
    ("hello" → "\\"hello\\""); bytes go as they are. Form media takes a mapping; text/*, octet-stream and others take
    a str or bytes as they are, a number or bool as text; an object raises TypeError.
    """
    types = spec["contentTypes"]
    json_type = next((t for t in types if _is_json(t)), None) if types else "application/json"
    media = json_type or types[0]
    if body is OMITTED or (body is None and not (json_type and spec.get("nullable"))):
        if spec["required"]:
            raise TypeError(f"{operation_id}: missing required body")
        return None, None
    if json_type:
        if isinstance(body, (bytes, bytearray)):
            return bytes(body), json_type
        return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), json_type
    if media == "application/x-www-form-urlencoded" and isinstance(body, Mapping):
        return urllib.parse.urlencode(body).encode("utf-8"), media
    if isinstance(body, (bytes, bytearray)):
        return bytes(body), media
    if isinstance(body, (dict, list, tuple)) or (body is not None and not isinstance(body, (str, int, float, bool))):
        raise TypeError(f"{operation_id}: a {media} body is a string or bytes, not an object")
    return (body if isinstance(body, str) else _text(body)).encode("utf-8"), media
