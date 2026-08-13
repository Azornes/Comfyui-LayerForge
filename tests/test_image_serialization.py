import base64
import io

from PIL import Image

from python.image_serialization import file_to_data_url, pil_to_data_url


def _decode_data_url(data_url):
    header, encoded = data_url.split(",", 1)
    return header, base64.b64decode(encoded)


def test_pil_to_data_url_preserves_png_mode_dimensions_and_pixels():
    image = Image.new("RGB", (2, 1), (255, 0, 128))

    data_url = pil_to_data_url(image)
    header, encoded = _decode_data_url(data_url)
    decoded = Image.open(io.BytesIO(encoded))

    assert header == "data:image/png;base64"
    assert decoded.mode == "RGB"
    assert decoded.size == (2, 1)
    assert decoded.getpixel((0, 0)) == (255, 0, 128)


def test_file_to_data_url_preserves_file_bytes_and_mime_type(tmp_path):
    path = tmp_path / "image.png"
    path.write_bytes(b"not-transformed-image-bytes")

    data_url = file_to_data_url(str(path), mime_type="image/png")
    header, encoded = _decode_data_url(data_url)

    assert header == "data:image/png;base64"
    assert encoded == b"not-transformed-image-bytes"
