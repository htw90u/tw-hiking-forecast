"""Derived QPF products: 6-hour QPF grids (F-C0041) and 24/48-hour totals.

The totals are sums of CWA's own 12-hour QPF periods. Each 12-hour period is
a rainfall *class* (e.g. 70-90 mm), so a total is reported as a range
(sum of lower bounds .. sum of upper bounds) plus a representative value
(sum of class mid-points) used for colouring.
"""
import numpy as np

from .grids import TWD67_TO_WGS84, parse_values
from .qpf import CLASS_BOUNDS


def class_ranges(cls: np.ndarray):
    """Class codes (0 no data, 1 dry <0.5 mm, 2.. legend classes) -> lo, hi, mid arrays."""
    lo = np.full(cls.shape, np.nan, np.float32)
    hi = np.full(cls.shape, np.nan, np.float32)
    mid = np.full(cls.shape, np.nan, np.float32)
    dry = cls == 1
    lo[dry], hi[dry], mid[dry] = 0.0, 0.5, 0.0
    for i, (a, b) in enumerate(CLASS_BOUNDS):
        m = cls == i + 2
        lo[m] = a
        hi[m] = np.inf if b is None else b
        mid[m] = a if b is None else (a + b) / 2
    return lo, hi, mid


def sum_classes(class_grids: list):
    """Sum several class grids -> (lo, hi, mid); hi is inf where an open class (>=300) occurs."""
    los, his, mids = zip(*(class_ranges(np.asarray(c)) for c in class_grids))
    return np.sum(los, axis=0), np.sum(his, axis=0), np.sum(mids, axis=0)


def parse_qpf6(doc: dict) -> dict:
    """F-C0041-00x (typhoon-warning 6-hour QPF grid, 130 x 130, TWD67) -> grid dict."""
    d = doc["cwaopendata"]["Dataset"]
    info = d["DatasetInfo"]
    vals = parse_values(d["Contents"]["Content"]["ContentText"])
    if vals.size != 130 * 130:
        raise ValueError(f"F-C0041 grid has {vals.size} values, expected 16900")
    arr = vals.reshape(130, 130)  # row 0 = 20.8 N (south), column 0 = 117.56 E
    arr = np.where(arr < 0, np.nan, arr).astype(np.float32)
    resx = (123.91 - 117.56) / 129
    resy = (26.65 - 20.8) / 129
    return {
        "data": arr, "lon0": 117.56 + TWD67_TO_WGS84[0], "lat0": 20.8 + TWD67_TO_WGS84[1], "res": resx, "resy": resy,
        "start": info.get("StartTime"), "end": info.get("EndTime"), "issue": info.get("IssueTime"),
    }
