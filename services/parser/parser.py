"""One bounded, network-isolated parser request over stdin; no path/URL input."""
import base64
import hashlib
import io
import json
import re
import resource
import sys

VERSION = "verification-native-parser.v1"
MAX_INPUT = 8_000_000
MAX_OUTPUT = 4_000_000
resource.setrlimit(resource.RLIMIT_CPU, (15, 16))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def html_projection(raw):
    import html5lib
    root = html5lib.parse(raw.decode("utf-8", errors="strict"), treebuilder="etree", namespaceHTMLElements=False)
    count = 0

    def node(element, depth):
        nonlocal count
        count += 1
        if count > 10_000 or depth > 60:
            raise ValueError("HTML_NODE_OR_DEPTH_LIMIT")
        if not isinstance(element.tag, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9:-]*", element.tag):
            return None
        tag = element.tag.lower()
        attributes = {k: v for k, v in element.attrib.items() if re.fullmatch(r"[A-Za-z_:][-A-Za-z0-9_:.]*", k)}
        identity = attributes.pop("id", None)
        style = attributes.get("style", "").lower()
        hidden = tag in {"head", "script", "style", "template", "noscript"} or "hidden" in attributes or attributes.get("aria-hidden", "").lower() == "true" or bool(re.search(r"(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))", style))
        result = {"tag": tag, "hidden": hidden}
        if identity:
            result["id"] = identity
        # Hidden/inert descendants are never selectable evidence. Keep their
        # position in the outer DOM but do not copy scripts, styles or hidden
        # payloads into the evidence projection. The original capture retains
        # those exact bytes for audit.
        if hidden:
            return result
        if attributes:
            result["attributes"] = attributes
        children = []
        if element.text:
            children.append({"tag": "#text", "text": element.text})
        for child in element:
            converted = node(child, depth + 1)
            if converted is not None:
                children.append(converted)
            if child.tail:
                children.append({"tag": "#text", "text": child.tail})
        if children:
            result["children"] = children
        return result

    dom = node(root, 0)

    def visible(n):
        if n.get("hidden"):
            return ""
        if n["tag"] == "#text":
            return n["text"]
        return "".join(visible(child) for child in n.get("children", []))

    projection = {"kind": "html_dom", "document": dom}
    # This optional convenience field duplicates DOM text; omitting it for a
    # long page preserves every visible text node and its structural selector.
    canonical_text = visible(dom)
    if len(canonical_text.encode("utf-16-le")) // 2 <= 100_000:
        projection["canonicalText"] = canonical_text
    return [projection], [{"code": "CSS_LAYOUT_NOT_EXECUTED", "detail": "External styles, script rendering and computed layout are not evaluated; hidden flags cover only declared inert/hidden content. Hidden subtrees are represented only by their inert root placeholder; their original bytes remain in the capture."}]


def pdf_projections(raw):
    import pdfplumber
    if not raw.startswith(b"%PDF-"):
        raise ValueError("PDF_SIGNATURE_INVALID")
    pages = []
    geometry = []
    residuals = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        if len(pdf.pages) > 40:
            raise ValueError("PDF_PAGE_LIMIT")
        if not pdf.pages:
            raise ValueError("PDF_EMPTY")
        for index, page in enumerate(pdf.pages, 1):
            text = page.extract_text(layout=False) or ""
            if len(text) > 100_000:
                raise ValueError("PDF_PAGE_TEXT_LIMIT")
            words = page.extract_words() or []
            if len(words) > 10_000:
                raise ValueError("PDF_PAGE_TOKEN_LIMIT")
            pages.append({"physicalPageNumber": index, "text": text, "textLayerDigest": digest(text.encode()), "widthPoints": page.width, "heightPoints": page.height})
            tokens = []
            for order, word in enumerate(words):
                x, y, right, bottom = (float(word[k]) for k in ("x0", "top", "x1", "bottom"))
                if x < 0 or y < 0 or right <= x or bottom <= y or right > page.width or bottom > page.height:
                    residuals.append({"code": "PDF_INVALID_WORD_BOX", "physicalPageNumber": index})
                    continue
                tokens.append({"text": word["text"], "x": x / page.width, "y": y / page.height, "width": (right - x) / page.width, "height": (bottom - y) / page.height, "coordinateSpace": "normalized", "order": order})
            geometry.append({"physicalPageNumber": index, "widthPoints": page.width, "heightPoints": page.height, "tokens": tokens})
            residuals.append({"code": "VISUAL_CONTENT_NOT_ASSESSED", "physicalPageNumber": index, "detail": "Native text and word boxes do not establish values present only in images or vector graphics."})
            page.close()
    projection_residuals = [{"kind": "unresolved_visual_content", "physicalPageNumber": page["physicalPageNumber"], "detail": "Visual evidence requires a separately admitted visual route."} for page in pages]
    return [{"kind": "pdf_text", "pageCount": len(pages), "pages": pages, "residuals": projection_residuals}, {"kind": "geometry", "pages": geometry}], residuals


def main():
    request_bytes = sys.stdin.buffer.read(11_000_001)
    if len(request_bytes) > 11_000_000:
        raise ValueError("REQUEST_BYTE_LIMIT")
    request = json.loads(request_bytes)
    if not isinstance(request, dict) or set(request) != {"kind", "contentBase64", "parentDigest"}:
        raise ValueError("REQUEST_SHAPE")
    raw = base64.b64decode(request["contentBase64"], validate=True)
    if len(raw) > MAX_INPUT or not raw:
        raise ValueError("INPUT_BYTE_LIMIT")
    if digest(raw) != request["parentDigest"]:
        raise ValueError("PARENT_DIGEST_MISMATCH")
    if request["kind"] == "html":
        projections, residuals = html_projection(raw)
    elif request["kind"] == "pdf":
        projections, residuals = pdf_projections(raw)
    else:
        raise ValueError("UNSUPPORTED_MEDIA")
    result = {"parserVersion": VERSION, "parentDigest": digest(raw), "projections": projections, "residuals": residuals}
    output = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(output) > MAX_OUTPUT:
        raise ValueError("OUTPUT_BYTE_LIMIT")
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Parser/native errors may contain source text: retain no raw exception.
        sys.stderr.write("PARSER_INPUT_OR_RESOURCE_FAILURE\n")
        sys.exit(2)
