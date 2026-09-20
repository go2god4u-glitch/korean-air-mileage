#!/usr/bin/env python3
"""Personal, loopback-only award-calendar viewer. Python 3.8+, no pip packages.

Only an explicit POST starts the existing Node/Playwright public-page collector.
GET requests and opening the UI read local files only. This is not a public server.
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
from pathlib import Path
import re
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError
import uuid
import webbrowser
from sas_store import SasStore
from sas_service import SasService, SasError
from award_service import AwardService

ROOT = Path(__file__).resolve().parent
SOURCE = "KOREAN_AIR_PUBLIC_AWARD_CALENDAR"
SOURCE_URL = "https://www.koreanair.com/booking/book-and-manage/award-seat-availability"
ACCOUNT_PAGES = {
    "korean-air": "https://www.koreanair.com/booking/search?bookingType=A&tripType=OW",
    "sas-eurobonus": "https://www.flysas.com/en/eurobonus/points/use/partner-award-flights/",
    "asiana-club": "https://flyasiana.com/I/KR/KO/MileageSeatSearch.do",
    "skyteam": "https://www.koreanair.com/booking/search?bookingType=S&tripType=RT",
    "star-alliance": "https://flyasiana.com/C/KR/KO/contents/book-online?tabId=mileage",
}


def booking_url(payload):
    """Builds the airline's own award-booking entry for one found date.

    Korean Air accepts the route and date as query parameters; Asiana publishes no
    such deep link, so its mileage booking page is opened as-is and the screen tells
    the user what to type. Both require the airline's login, which lives in the
    user's regular Chrome — never here."""
    if not isinstance(payload, dict):
        raise AppError("INVALID_INPUT", "예매 정보를 확인해 주세요.")
    program = payload.get("program")
    if program not in BUSINESS_SCAN_PROGRAMS:
        raise AppError("INVALID_INPUT", "항공사를 확인해 주세요.")
    origin, destination = (str(payload.get(field, "")).strip().upper() for field in ("origin", "destination"))
    for code in (origin, destination):
        if not re.fullmatch(r"[A-Z]{3}", code):
            raise AppError("INVALID_AIRPORT", "공항 코드를 확인해 주세요.")
    if origin == destination:
        raise AppError("SAME_AIRPORT", "출발지와 도착지를 다르게 선택해 주세요.")
    value = payload.get("date")
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise AppError("INVALID_DATE", "날짜를 확인해 주세요.")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise AppError("INVALID_DATE", "날짜를 올바르게 선택해 주세요.")

    if program == "korean-air":
        url = ("https://www.koreanair.com/booking/search?bookingType=A&tripType=OW"
               "&departureAirportCode=%s&arrivalAirportCode=%s&departureDate=%s&adultCount=1"
               % (origin, destination, value.replace("-", "")))
        prefilled = True
    else:
        url = "https://flyasiana.com/C/KR/KO/contents/book-online?tabId=mileage"
        prefilled = False
    account = str(payload.get("account", "default")).strip() or "default"
    if not re.fullmatch(r"[A-Za-z0-9-]{1,24}", account):
        raise AppError("INVALID_INPUT", "계정 이름을 확인해 주세요.")
    return {"url": url, "program": program, "origin": origin, "account": account,
            "destination": destination, "date": value, "prefilled": prefilled}


def open_in_chrome(url):
    """Opens an allowlisted airline page in the user's regular Chrome, where their
    airline login already lives. This app never sees or stores those credentials."""
    host = urlparse(url).hostname or ""
    if host not in ("www.koreanair.com", "flyasiana.com"):
        raise AppError("INVALID_INPUT", "허용되지 않은 주소예요.")
    if sys.platform == "darwin":
        command = ["open", "-a", "Google Chrome", url]
    elif sys.platform == "win32":
        candidates = [Path(os.environ.get(base, "")) / "Google/Chrome/Application/chrome.exe"
                      for base in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
                      if os.environ.get(base)]
        chrome = shutil.which("chrome") or next((str(p) for p in candidates if p.is_file()), None)
        command = [chrome, url] if chrome else None
    else:
        chrome = shutil.which("google-chrome") or shutil.which("google-chrome-stable") or shutil.which("chromium")
        command = [chrome, url] if chrome else None
    if not command:
        raise AppError("CHROME_NOT_FOUND", "Google Chrome을 설치한 뒤 다시 눌러 주세요.", 503)
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if process.wait(timeout=0.5) != 0:
                raise OSError("Chrome launch failed")
        except subprocess.TimeoutExpired:
            pass  # Chrome stays open on Windows/Linux.
    except OSError:
        raise AppError("CHROME_OPEN_FAILED", "Chrome을 열지 못했어요. 설치 상태를 확인해 주세요.", 503)


def open_account_page(payload):
    """Open an allowlisted official page in the user's regular Chrome profile."""
    program = payload.get("program") if isinstance(payload, dict) else None
    if not isinstance(program, str) or program not in ACCOUNT_PAGES:
        raise AppError("INVALID_INPUT", "항공사 또는 마일리지 프로그램을 선택해 주세요.")
    url = ACCOUNT_PAGES[program]
    if sys.platform == "darwin":
        command = ["open", "-a", "Google Chrome", url]
    elif sys.platform == "win32":
        candidates = [Path(os.environ.get(base, "")) / "Google/Chrome/Application/chrome.exe"
                      for base in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
                      if os.environ.get(base)]
        chrome = shutil.which("chrome") or next((str(p) for p in candidates if p.is_file()), None)
        command = [chrome, url] if chrome else None
    else:
        chrome = shutil.which("google-chrome") or shutil.which("google-chrome-stable") or shutil.which("chromium")
        command = [chrome, url] if chrome else None
    if not command:
        raise AppError("CHROME_NOT_FOUND", "Google Chrome을 설치한 뒤 다시 눌러 주세요.", 503)
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if process.wait(timeout=0.5) != 0:
                raise OSError("Chrome launch failed")
        except subprocess.TimeoutExpired:
            pass  # Chrome stays open on Windows/Linux.
    except OSError:
        raise AppError("CHROME_OPEN_FAILED", "Chrome을 열지 못했어요. 설치 상태를 확인해 주세요.", 503)
    return {"url": url, "message": "Chrome에 공식 사이트를 열었어요. 필요한 경우 해당 사이트에서 로그인해 주세요. 로그인 여부는 이 앱에서 확인하지 않습니다."}
SEOUL = timezone(timedelta(hours=9))
CACHE_SECONDS = 12 * 3600
CABINS = ("economy", "premium", "prestige")
# "all" is a display choice, not an additional field in the saved calendar.
CABIN_CHOICES = ("all",) + CABINS
RESTRICTIONS = {"ACCESS_RESTRICTED", "USER_ACTION_REQUIRED", "LOGIN_REQUIRED"}
HANDOFF_TIMEOUT_SECONDS = 150
HANDOFF_STATUS_LIMIT = 8192
ROUTE_CATALOG_LIMIT = 2 * 1024 * 1024
HANDOFF_MESSAGES = {
    "date_selected": "선택한 날짜로 대한항공을 열었어요. Chrome 창에서 확인해 주세요.",
    "form_filled": "대한항공에 왕복 노선과 조회할 달을 입력했어요. 날짜와 좌석 등급은 Chrome 창에서 선택해 주세요.",
}


class AppError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def utc_now():
    return datetime.now(timezone.utc)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed


def validate_route_catalog(value):
    """Validate the public static catalogue without inferring extra routes."""
    if not isinstance(value, dict):
        raise ValueError("route catalogue must be an object")
    source_url = value.get("sourceUrl")
    if not isinstance(source_url, str) or not source_url or len(source_url) > 2048:
        raise ValueError("source URL required")
    source = urlparse(source_url)
    if source.scheme != "https" or not source.hostname or source.username or source.password:
        raise ValueError("invalid public source URL")
    retrieved_at = value.get("retrievedAt")
    timestamp(retrieved_at)
    airports = value.get("airports")
    if not isinstance(airports, list) or not airports:
        raise ValueError("airport list required")
    codes, normalized_airports = set(), []
    for airport in airports:
        if not isinstance(airport, dict):
            raise ValueError("invalid airport")
        code = airport.get("code")
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z]{3}", code) or code in codes:
            raise ValueError("invalid or duplicate airport code")
        entry = {"code": code}
        for key in ("name", "region"):
            text = airport.get(key)
            if (not isinstance(text, str) or not text.strip() or len(text) > 200
                    or any(ord(character) < 32 for character in text)):
                raise ValueError("invalid airport label")
            entry[key] = text.strip()
        codes.add(code)
        normalized_airports.append(entry)
    destinations = value.get("destinations")
    if not isinstance(destinations, dict):
        raise ValueError("destination mapping required")
    # An empty mapping means route connections have not been verified. It must
    # not turn a public airport list into an invented all-to-all route network.
    normalized_destinations = {}
    for origin, arrivals in destinations.items():
        if not isinstance(origin, str) or origin not in codes or not isinstance(arrivals, list):
            raise ValueError("unknown origin or invalid destinations")
        seen = set()
        for arrival in arrivals:
            if not isinstance(arrival, str) or arrival not in codes or arrival == origin or arrival in seen:
                raise ValueError("unknown, duplicate, or identical destination")
            seen.add(arrival)
        normalized_destinations[origin] = list(arrivals)
    return {"sourceUrl": source_url, "retrievedAt": retrieved_at,
            "airports": normalized_airports, "destinations": normalized_destinations}


def route_object_pairs(pairs):
    """Reject duplicate JSON keys rather than silently replacing a route list."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate route catalogue key")
        result[key] = value
    return result


def read_route_catalog(root=ROOT):
    """GET reads this fixed local file only; it never refreshes from the airline."""
    path = Path(root) / "config" / "award-routes.json"
    try:
        with path.open("rb") as source:
            content = source.read(ROUTE_CATALOG_LIMIT + 1)
    except OSError:
        raise AppError("ROUTES_UNAVAILABLE", "공항 목록을 불러오지 못했어요. 공항 코드를 직접 입력해 주세요.", 503)
    try:
        if len(content) > ROUTE_CATALOG_LIMIT:
            raise ValueError("route catalogue too large")
        value = json.loads(content.decode("utf-8"), object_pairs_hook=route_object_pairs)
        return validate_route_catalog(value)
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise AppError("ROUTES_INVALID", "저장된 공항 목록을 확인할 수 없어요. 공항 코드를 직접 입력해 주세요.", 503)


def month_bounds(today=None):
    """A month is offered once its first day is bookable. Days past the horizon
    inside it come back as NOT_YET_OPEN rather than as no seats."""
    today = today or datetime.now(SEOUL).date()
    minimum = (today.replace(day=1) + timedelta(days=32)).replace(day=1)
    # Korean Air opens one more day each morning at 09:00 KST: the date 360 days
    # out. Stopping at 359 hid that newly opened day whenever it began a month.
    maximum = (today + timedelta(days=360)).replace(day=1)
    return minimum.strftime("%Y-%m"), maximum.strftime("%Y-%m")


def validate_request(raw, today=None):
    if not isinstance(raw, dict):
        raise AppError("INVALID_INPUT", "검색 조건을 확인해 주세요.")
    params = {}
    for field, label in (("origin", "출발지"), ("destination", "도착지")):
        value = str(raw.get(field, "")).strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", value):
            raise AppError("INVALID_AIRPORT", "%s 공항의 영문 코드 3자리를 입력해 주세요. 예: ICN" % label)
        params[field] = value
    if params["origin"] == params["destination"]:
        raise AppError("SAME_AIRPORT", "출발지와 도착지를 다르게 선택해 주세요.")
    params["tripType"] = raw.get("tripType", "ONE_WAY")
    if params["tripType"] not in ("ONE_WAY", "ROUND_TRIP"):
        raise AppError("INVALID_TRIP", "편도 또는 왕복을 선택해 주세요.")
    params["cabin"] = raw.get("cabin", "prestige")
    if params["cabin"] not in CABIN_CHOICES:
        raise AppError("INVALID_CABIN", "전체, 일반석, 프리미엄석, 비즈니스석 중에서 선택해 주세요.")
    minimum, maximum = month_bounds(today)
    fields = ["month"] + (["returnMonth"] if params["tripType"] == "ROUND_TRIP" else [])
    for field in fields:
        value = raw.get(field, "")
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
            raise AppError("INVALID_MONTH", "조회할 달을 선택해 주세요.")
        if not minimum <= value <= maximum:
            raise AppError("MONTH_OUT_OF_RANGE", "지금은 %s부터 %s까지 한 달씩 조회할 수 있어요." % (minimum, maximum))
        params[field] = value
    if params.get("returnMonth", params["month"]) < params["month"]:
        raise AppError("INVALID_RETURN_MONTH", "오는 달은 가는 달보다 앞설 수 없어요.")
    return params


BUSINESS_SCAN_PROGRAMS = ("korean-air", "asiana-club")
# A long sweep is fine — it runs one request at a time and can be stopped mid-way.
# This bound only catches a runaway request, not a deliberately wide search.
BUSINESS_SCAN_MAX_LEGS = 2000
# An airline that does not fly a route answers differently from one that is simply
# out of seats, so these are remembered and skipped instead of retried every scan.
UNSUPPORTED_ROUTE_CODES = {"ROUTE_UNAVAILABLE", "UNSUPPORTED_ROUTE", "AIRPORT_NOT_FOUND"}
# Seconds to leave between Asiana lookups. Its site refuses rapid repeats.
ASIANA_REQUEST_INTERVAL = 20


def business_scan_months(start_month, end_month, today=None):
    minimum, maximum = month_bounds(today)
    for value, label in ((start_month, "시작 달"), (end_month, "끝 달")):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
            raise AppError("INVALID_MONTH", "조회할 기간을 선택해 주세요.")
    if not (minimum <= start_month <= maximum) or not (minimum <= end_month <= maximum):
        raise AppError("MONTH_OUT_OF_RANGE", "지금은 %s부터 %s까지 조회할 수 있어요." % (minimum, maximum))
    if start_month > end_month:
        raise AppError("INVALID_RETURN_MONTH", "끝 달은 시작 달보다 앞설 수 없어요.")
    months = []
    year, month = map(int, start_month.split("-"))
    end_year, end_month_number = map(int, end_month.split("-"))
    while (year, month) <= (end_year, end_month_number):
        months.append("%04d-%02d" % (year, month))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return months


def validate_business_scan_request(raw, today=None):
    """One request can sweep many origin/destination/month combinations at once.
    Region names are cross-checked against the same static catalogue the single-route
    combobox uses, never invented from free text."""
    if not isinstance(raw, dict):
        raise AppError("INVALID_INPUT", "검색 조건을 확인해 주세요.")
    catalog = read_route_catalog()
    known_regions = {airport["region"] for airport in catalog["airports"]}

    def codes(field, label, allow_empty_default=None):
        values = raw.get(field, [])
        if values in (None, []) and allow_empty_default is not None:
            return list(allow_empty_default)
        if not isinstance(values, list):
            raise AppError("INVALID_INPUT", "%s 목록을 확인해 주세요." % label)
        result, seen = [], set()
        for value in values:
            code = str(value).strip().upper()
            if not re.fullmatch(r"[A-Z]{3}", code) or code in seen:
                raise AppError("INVALID_AIRPORT", "%s 공항 코드를 확인해 주세요." % label)
            seen.add(code)
            result.append(code)
        return result

    origins = codes("origins", "출발", allow_empty_default=["ICN"])
    if not origins:
        raise AppError("INVALID_INPUT", "출발 공항을 하나 이상 선택해 주세요.")

    explicit_destinations = codes("destinations", "도착")
    regions = raw.get("regions", [])
    if not isinstance(regions, list):
        raise AppError("INVALID_INPUT", "지역 목록을 확인해 주세요.")
    region_names = []
    for value in regions:
        name = str(value)
        if name not in known_regions:
            raise AppError("INVALID_REGION", "알 수 없는 지역이에요. 목록에서 다시 선택해 주세요.")
        region_names.append(name)

    destination_set = set(explicit_destinations)
    for airport in catalog["airports"]:
        if airport["region"] in region_names:
            destination_set.add(airport["code"])
    destinations = sorted(destination_set - set(origins))
    if not destinations:
        raise AppError("INVALID_INPUT", "목적지를 하나 이상 선택하거나 지역을 골라 주세요.")

    programs = raw.get("programs", list(BUSINESS_SCAN_PROGRAMS))
    if not isinstance(programs, list) or not programs or any(p not in BUSINESS_SCAN_PROGRAMS for p in programs):
        raise AppError("INVALID_INPUT", "조회할 프로그램을 선택해 주세요.")
    programs = [p for p in BUSINESS_SCAN_PROGRAMS if p in programs]

    minimum, maximum = month_bounds(today)
    months = business_scan_months(raw.get("startMonth", minimum), raw.get("endMonth", maximum), today)

    total = len(origins) * len(destinations) * len(months)
    if total > BUSINESS_SCAN_MAX_LEGS:
        raise AppError("SCAN_TOO_LARGE",
                        "조합이 %d건이라 한 번에 처리하기 어려워요(최대 %d건). 지역이나 기간을 조금 줄여 주세요." % (total, BUSINESS_SCAN_MAX_LEGS))

    return {"origins": origins, "destinations": destinations, "months": months, "programs": programs}


WATCHES_PATH = ROOT / "config" / "watches.json"


def read_watches(root=ROOT):
    path = Path(root) / "config" / "watches.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return {"watches": []}
    except ValueError:
        raise AppError("WATCHES_INVALID", "알림 신청 목록을 읽지 못했어요.", 503)
    watches = value.get("watches")
    return {"watches": watches if isinstance(watches, list) else []}


def validate_watch(raw, today=None):
    """A watch is a standing request: these routes, these dates, alert me when a
    business seat shows up. It is stored in the repository so the scheduled cloud
    scan reads exactly what the screen shows."""
    if not isinstance(raw, dict):
        raise AppError("INVALID_INPUT", "알림 조건을 확인해 주세요.")
    catalog = read_route_catalog()
    known_regions = {airport["region"] for airport in catalog["airports"]}

    def codes(field, label):
        values = raw.get(field, [])
        if not isinstance(values, list):
            raise AppError("INVALID_INPUT", "%s 목록을 확인해 주세요." % label)
        result, seen = [], set()
        for value in values:
            code = str(value).strip().upper()
            if not re.fullmatch(r"[A-Z]{3}", code) or code in seen:
                raise AppError("INVALID_AIRPORT", "%s 공항 코드를 확인해 주세요." % label)
            seen.add(code)
            result.append(code)
        return result

    origins = codes("origins", "출발") or ["ICN"]
    destinations = codes("destinations", "도착")
    regions = raw.get("regions", [])
    if not isinstance(regions, list) or any(str(r) not in known_regions for r in regions):
        raise AppError("INVALID_REGION", "알 수 없는 지역이에요. 목록에서 다시 선택해 주세요.")
    regions = [str(r) for r in regions]
    if not destinations and not regions:
        raise AppError("INVALID_INPUT", "도착 공항이나 지역을 하나 이상 선택해 주세요.")

    dates = {}
    for field, label in (("startDate", "시작 날짜"), ("endDate", "끝 날짜")):
        value = raw.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise AppError("INVALID_DATE", "%s를 선택해 주세요." % label)
        try:
            dates[field] = date.fromisoformat(value)
        except ValueError:
            raise AppError("INVALID_DATE", "%s를 올바르게 선택해 주세요." % label)
    if dates["endDate"] < dates["startDate"]:
        raise AppError("INVALID_DATE", "끝 날짜는 시작 날짜보다 앞설 수 없어요.")

    programs = raw.get("programs", list(BUSINESS_SCAN_PROGRAMS))
    if not isinstance(programs, list) or not programs or any(p not in BUSINESS_SCAN_PROGRAMS for p in programs):
        raise AppError("INVALID_INPUT", "조회할 프로그램을 선택해 주세요.")

    label = str(raw.get("label", "")).strip()[:60]
    identifier = raw.get("id")
    if identifier is not None and (not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{12}", identifier)):
        raise AppError("INVALID_INPUT", "알림 신청을 찾지 못했어요.")
    return {
        "id": identifier or uuid.uuid4().hex[:12],
        "label": label or "%s → %s" % (origins[0], ", ".join(destinations + regions)[:40]),
        "origins": origins, "destinations": destinations, "regions": regions,
        "startDate": raw["startDate"], "endDate": raw["endDate"],
        "programs": [p for p in BUSINESS_SCAN_PROGRAMS if p in programs],
        "enabled": bool(raw.get("enabled", True)),
        "updatedAt": utc_now().isoformat(),
    }


def save_watches(watches, root=ROOT):
    path = Path(root) / "config" / "watches.json"
    temporary = path.with_name(path.name + ".%s.tmp" % uuid.uuid4().hex)
    try:
        with open(temporary, "x", encoding="utf-8") as output:
            json.dump({"watches": watches}, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def git_command(arguments, root=ROOT):
    git = shutil.which("git")
    if not git:
        raise AppError("GIT_MISSING", "git을 찾지 못해 GitHub에 반영하지 못했어요.", 503)
    result = subprocess.run([git] + arguments, cwd=str(root), capture_output=True, text=True, timeout=90)
    return result


def sync_watches_to_github(root=ROOT):
    """Publishes the watch list so the scheduled cloud scan uses it."""
    status = git_command(["status", "--porcelain", "config/watches.json"], root)
    if status.returncode != 0:
        raise AppError("GIT_FAILED", "변경 사항을 확인하지 못했어요.", 503)
    if status.stdout.strip():
        add = git_command(["add", "config/watches.json"], root)
        commit = git_command(["commit", "-m", "chore: update alert watches"], root)
        if add.returncode != 0 or commit.returncode != 0:
            raise AppError("GIT_FAILED", "변경 사항을 저장하지 못했어요.", 503)
    pull = git_command(["pull", "--rebase", "origin", "main"], root)
    if pull.returncode != 0:
        raise AppError("GIT_FAILED", "GitHub의 최신 내용을 가져오지 못했어요. 터미널에서 확인해 주세요.", 503)
    push = git_command(["push", "origin", "main"], root)
    if push.returncode != 0:
        raise AppError("GIT_FAILED", "GitHub에 올리지 못했어요. 터미널에서 git push를 확인해 주세요.", 503)
    return {"synced": True, "message": "GitHub에 반영했어요. 다음 정시 실행부터 적용돼요."}


def watches_sync_state(root=ROOT):
    """Whether the saved watches differ from what GitHub already has."""
    status = git_command(["status", "--porcelain", "config/watches.json"], root)
    pending = bool(status.stdout.strip()) if status.returncode == 0 else None
    ahead = git_command(["rev-list", "--count", "origin/main..HEAD"], root)
    unpushed = int(ahead.stdout.strip() or 0) if ahead.returncode == 0 else 0
    return {"pendingChanges": pending, "unpushedCommits": unpushed}


def cloud_runs(limit=3, root=ROOT):
    """Best-effort read of the scheduled cloud scans through the GitHub CLI."""
    gh = shutil.which("gh")
    if not gh:
        return {"available": False, "runs": []}
    try:
        result = subprocess.run(
            [gh, "run", "list", "--workflow=business-scan.yml", "--limit", str(limit),
             "--json", "status,conclusion,createdAt,updatedAt,databaseId,url"],
            cwd=str(root), capture_output=True, text=True, timeout=25)
        if result.returncode != 0:
            return {"available": False, "runs": []}
        return {"available": True, "runs": json.loads(result.stdout or "[]")}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"available": False, "runs": []}


def validate_handoff_request(raw, today=None):
    """Only explicit, valid dates attached to the displayed month are forwarded."""
    params = validate_request(raw, today)
    for field, month_field, label in (("outboundDate", "month", "가는 날"),
                                      ("returnDate", "returnMonth", "오는 날")):
        if field == "returnDate" and params["tripType"] == "ONE_WAY":
            params[field] = None
            continue
        value = raw.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise AppError("INVALID_DATE", "%s을 선택해 주세요." % label)
        try:
            date.fromisoformat(value)
        except ValueError:
            raise AppError("INVALID_DATE", "%s을 올바른 날짜로 선택해 주세요." % label)
        if value[:7] != params[month_field]:
            raise AppError("DATE_MONTH_MISMATCH", "%s이 조회한 달과 달라요. 날짜를 다시 선택해 주세요." % label)
        params[field] = value
    if params["returnDate"] is not None and params["returnDate"] < params["outboundDate"]:
        raise AppError("INVALID_RETURN_DATE", "오는 날은 가는 날보다 앞설 수 없어요.")
    return params


def legs_for(params):
    legs = [{"direction": "outbound", "origin": params["origin"], "destination": params["destination"], "month": params["month"]}]
    if params["tripType"] == "ROUND_TRIP":
        legs.append({"direction": "inbound", "origin": params["destination"], "destination": params["origin"], "month": params["returnMonth"]})
    return legs


def cache_key(leg):
    return "%s-%s-ONE_WAY-%s" % (leg["origin"], leg["destination"], leg["month"])


def validate_calendar(value, leg):
    """Reject incomplete/corrupt caches rather than turning them into no seats."""
    if not isinstance(value, dict) or value.get("source") != SOURCE or value.get("tripType") != "ONE_WAY":
        raise ValueError("invalid source")
    if any(value.get(field) != leg[field] for field in ("origin", "destination", "month")):
        raise ValueError("route/month mismatch")
    timestamp(value.get("collectedAt"))
    if value.get("sourceUpdatedAt") is not None:
        timestamp(value["sourceUpdatedAt"])
    year, month = map(int, leg["month"].split("-"))
    expected = {"%s-%02d" % (leg["month"], day) for day in range(1, calendar.monthrange(year, month)[1] + 1)}
    rows = value.get("dates")
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise ValueError("incomplete month")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("date") not in expected or row["date"] in seen:
            raise ValueError("invalid or duplicate day")
        seen.add(row["date"])
        # A day past the booking horizon publishes nothing, so its markers are
        # null. Only that state may carry nulls; anything else must be explicit.
        not_yet_open = row.get("availabilityType") == "NOT_YET_OPEN"
        allowed = (bool, type(None)) if not_yet_open else (bool,)
        if any(not isinstance(row.get(cabin + "Award"), allowed) for cabin in CABINS):
            raise ValueError("unverified award marker")
        if row.get("availabilityType") not in ("PUBLIC_INDICATOR", "NOT_YET_OPEN") or row.get("availableSeatCount") is not None:
            raise ValueError("unverified seat quantity")
    return value


class CalendarStore:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.directory = self.root / "data" / "local"
        self.block_path = self.directory / "access-restricted.json"

    def read(self, leg):
        candidates = [self.directory / (cache_key(leg) + ".json"), self.root / "data" / (cache_key(leg) + ".json")]
        valid = []
        for file in candidates:
            try:
                value = validate_calendar(json.loads(file.read_text(encoding="utf-8")), leg)
                valid.append(value)
            except (OSError, ValueError, TypeError, KeyError):
                continue
        return max(valid, key=lambda item: timestamp(item["collectedAt"])) if valid else None

    def write_json(self, path, value):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(path.name + ".%s.tmp" % uuid.uuid4().hex)
        try:
            with open(temporary, "x", encoding="utf-8") as output:
                os.chmod(temporary, 0o600)
                json.dump(value, output, ensure_ascii=False, indent=2)
                output.write("\n")
            os.replace(str(temporary), str(path))
        finally:
            if temporary.exists():
                temporary.unlink()

    def save(self, value, leg):
        validate_calendar(value, leg)
        self.write_json(self.directory / (cache_key(leg) + ".json"), value)

    @staticmethod
    def stale(value):
        age = (utc_now() - timestamp(value["collectedAt"])).total_seconds()
        return age < 0 or age >= CACHE_SECONDS

    def result(self, params, fetched=()):
        result, missing = [], []
        for leg in legs_for(params):
            value = self.read(leg)
            result.append(dict(leg, calendar=value, cached=bool(value) and cache_key(leg) not in fetched,
                               stale=self.stale(value) if value else False))
            if value is None:
                missing.append(leg["direction"])
        return {"state": "missing" if missing else "complete", "legs": result, "missing": missing, "params": params}


def is_windows():
    return os.name == "nt"


def process_creation_options():
    """Own a separate process group without passing POSIX flags on Windows."""
    if is_windows():
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)}
    return {"start_new_session": True}


def stop_owned_process(process):
    """Terminate only this launched task's process tree, never all browsers."""
    if type(process.pid) is not int or process.pid <= 0:
        raise ValueError("A positive child PID is required")
    if is_windows():
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10, check=False,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
        except (OSError, subprocess.TimeoutExpired):
            # Retain a bounded fallback for a missing or unresponsive taskkill.
            # This still targets only our child, never an executable name.
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        return
    for sig in (signal.SIGTERM, getattr(signal, "SIGKILL", 9)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Some hosts reject signalling a group whose leader has already
            # exited. Popen checks/reaps that exact child before signalling it.
            try:
                process.send_signal(sig)
            except OSError:
                pass
        try:
            process.wait(timeout=5)
            break
        except subprocess.TimeoutExpired:
            continue


def collect_leg(leg, root=ROOT):
    node = shutil.which("node")
    tsx = Path(root) / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not node or not tsx.is_file():
        raise AppError("DEPENDENCIES_MISSING", "조회에 필요한 도구가 아직 설치되지 않았어요. 프로젝트 폴더에서 npm ci를 실행해 주세요.")
    # Korean Air's edge refuses real headless Chrome, so the collector stays headed
    # and parks its window off-screen instead of interrupting the desktop.
    command = [node, str(tsx), str(Path(root) / "scripts" / "local-collect.ts"),
               "--origin", leg["origin"], "--destination", leg["destination"], "--month", leg["month"], "--hidden"]
    process = subprocess.Popen(command, cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace", **process_creation_options())
    try:
        stdout, stderr = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        stop_owned_process(process)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise AppError("COLLECTION_TIMEOUT", "조회가 오래 걸려 중단했어요. 이전에 저장한 결과는 그대로 남아 있어요.")
    if process.returncode:
        stop_owned_process(process)
        try:
            payload = json.loads(stderr.strip().splitlines()[-1])
            code = payload.get("code", "COLLECTION_FAILED")
            if not isinstance(code, str):
                code = "COLLECTION_FAILED"
        except (ValueError, IndexError, AttributeError):
            code = "COLLECTION_FAILED"
        messages = {
            "ACCESS_RESTRICTED": "대한항공에서 접속을 제한해 조회를 멈췄어요. 저장된 결과가 있다면 그대로 보여드려요.",
            "USER_ACTION_REQUIRED": "대한항공에서 보안 확인을 요청해 조회를 멈췄어요.",
            "LOGIN_REQUIRED": "대한항공에서 로그인을 요청해 조회를 멈췄어요.",
            "AIRPORT_NOT_FOUND": "입력한 공항을 찾지 못했어요. 공항 코드를 확인해 주세요.",
            "UNSUPPORTED_ROUTE": "대한항공에서 이 노선의 좌석 정보를 찾지 못했어요.",
            "MONTH_OUT_OF_RANGE": "조회할 수 있는 기간 안에서 달을 선택해 주세요.",
        }
        raise AppError(code if isinstance(code, str) else "COLLECTION_FAILED", messages.get(code, "좌석 정보를 가져오지 못했어요. 좌석이 없다는 뜻은 아니에요. 이전에 저장한 결과는 그대로 남아 있어요."))
    try:
        return validate_calendar(json.loads(stdout)["calendar"], leg)
    except (ValueError, KeyError, TypeError):
        stop_owned_process(process)
        raise AppError("INVALID_RESULT", "조회 결과가 선택한 노선과 날짜에 맞는지 확인하지 못했어요. 이전에 저장한 결과는 그대로 남아 있어요.")


def handoff_error(code="HANDOFF_FAILED"):
    # Never surface child-process messages, URLs, account details, or raw stacks.
    messages = {
        "ACCESS_RESTRICTED": "대한항공에서 접속을 제한해 자동 입력을 멈췄어요. 저장된 결과는 그대로 남아 있어요.",
        "USER_ACTION_REQUIRED": "대한항공에서 보안 확인을 요청해 자동 입력을 멈췄어요.",
        "LOGIN_REQUIRED": "대한항공에서 로그인을 요청해 자동 입력을 멈췄어요.",
        "AIRPORT_NOT_FOUND": "대한항공에서 입력한 공항을 찾지 못했어요. 공항 코드를 확인해 주세요.",
        "UNSUPPORTED_ROUTE": "대한항공에서 선택한 노선의 조회 화면을 찾지 못했어요.",
        "MONTH_OUT_OF_RANGE": "대한항공에서 선택한 달을 조회할 수 없어요. 조회할 달을 다시 선택해 주세요.",
        "HANDOFF_TIMEOUT": "대한항공 화면을 여는 데 오래 걸려 중단했어요. 선택한 날짜와 조회 결과는 그대로 남아 있어요.",
        "BROWSER_OPEN_FAILED": "Chrome을 열지 못했어요. Google Chrome이 설치되어 있는지 확인해 주세요.",
        "FORM_FAILED": "대한항공 화면에 노선과 월을 입력하지 못했어요. 선택한 날짜와 조회 결과는 그대로 남아 있어요.",
        "FILTER_FAILED": "대한항공 화면에 좌석 등급을 적용하지 못했어요. 선택한 날짜와 조회 결과는 그대로 남아 있어요.",
        "DATE_NOT_SELECTED": "대한항공 달력에서 선택한 날짜를 확인하지 못했어요. 선택한 날짜와 조회 결과는 그대로 남아 있어요.",
        "DEPENDENCIES_MISSING": "자동 입력에 필요한 도구가 아직 설치되지 않았어요. 프로젝트 폴더에서 npm ci를 실행해 주세요.",
        "HANDOFF_FAILED": "대한항공에 선택한 조건을 입력하지 못했어요. 선택한 날짜와 조회 결과는 그대로 남아 있어요.",
    }
    safe_code = code if isinstance(code, str) and code in messages else "HANDOFF_FAILED"
    return AppError(safe_code, messages[safe_code])


def stop_handoff_process(process):
    stop_owned_process(process)
    reader = getattr(process, "_handoff_reader_thread", None)
    if isinstance(reader, threading.Thread):
        reader.join(timeout=1)
        if reader.is_alive():
            # The abandoned reader will close its pipe when the child tree
            # releases it. Closing a locked BufferedReader here could block.
            return
    if process.stdout:
        process.stdout.close()


def read_handoff_status(process, timeout=HANDOFF_TIMEOUT_SECONDS):
    """Bounded first-line read using threads/queue on both Windows and POSIX."""
    messages = queue.Queue(maxsize=1)
    abandoned = threading.Event()

    def read_first_line():
        try:
            # Binary readline retains any buffered later output in this same
            # stream for the success reaper and also handles partial writes.
            line = process.stdout.readline(HANDOFF_STATUS_LIMIT + 1)
            if not line.endswith(b"\n") or len(line) > HANDOFF_STATUS_LIMIT + 1:
                messages.put((False, None))
                return
            try:
                payload = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeError):
                messages.put((False, None))
                return
            messages.put((isinstance(payload, dict), payload))
        except (OSError, ValueError):
            messages.put((False, None))
        finally:
            if abandoned.is_set():
                process.stdout.close()

    reader = threading.Thread(target=read_first_line, daemon=True)
    process._handoff_reader_thread = reader
    reader.start()
    try:
        valid, payload = messages.get(timeout=max(0, timeout))
    except queue.Empty:
        abandoned.set()
        raise handoff_error("HANDOFF_TIMEOUT")
    if not valid:
        raise handoff_error()
    return payload


def reap_handoff_process(process):
    """Drain output and reap on user closure; a successful browser stays open."""
    try:
        while process.stdout.read(4096):
            pass
    except (OSError, ValueError):
        pass
    finally:
        try:
            process.wait()
        finally:
            process.stdout.close()


def open_airline(selection, root=ROOT):
    node = shutil.which("node")
    tsx = Path(root) / "node_modules" / "tsx" / "dist" / "cli.mjs"
    script = Path(root) / "scripts" / "open-airline.ts"
    if not node or not tsx.is_file() or not script.is_file():
        raise AppError("DEPENDENCIES_MISSING", "자동 입력에 필요한 도구가 아직 설치되지 않았어요. 프로젝트 폴더에서 npm ci를 실행해 주세요.")
    process = None
    try:
        process = subprocess.Popen([node, str(tsx), str(script)], cwd=str(root),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   **process_creation_options())
        try:
            process.stdin.write((json.dumps(selection, ensure_ascii=False) + "\n").encode("utf-8"))
            process.stdin.flush()
        finally:
            process.stdin.close()
        payload = read_handoff_status(process)
        if payload.get("status") == "failed":
            raise handoff_error(payload.get("code"))
        stage = payload.get("stage")
        if payload.get("status") != "ready" or not isinstance(stage, str) or stage not in HANDOFF_MESSAGES:
            raise handoff_error()
        reported = payload.get("selection")
        selection_fields = ("origin", "destination", "tripType", "cabin", "month", "returnMonth", "outboundDate", "returnDate")
        # The helper omits unused return fields. Missing and null mean the same
        # thing; a different route/date/cabin must never be reported as success.
        if not isinstance(reported, dict) or any(reported.get(key) != selection.get(key) for key in selection_fields):
            raise handoff_error()
        result = {"kind": "airline-handoff", "selection": dict(selection), "stage": stage,
                  "message": HANDOFF_MESSAGES[stage]}
        threading.Thread(target=reap_handoff_process, args=(process,), daemon=True).start()
        return result
    except Exception as error:
        if process is not None:
            stop_handoff_process(process)
        if isinstance(error, AppError):
            raise
        raise handoff_error()


class SearchService:
    def __init__(self, store=None, collector=None, handoff=None):
        self.store = store or CalendarStore()
        self.collector = collector or collect_leg
        self.handoff = handoff or open_airline
        self.lock = threading.RLock()
        self.jobs = {}
        self.active = None
        self.restricted = self.store.block_path.exists()

    def start(self, params):
        with self.lock:
            if self.active:
                raise AppError("BUSY", "다른 조회나 자동 입력을 진행하고 있어요. 끝난 뒤 다시 눌러 주세요.", 409)
            job_id = uuid.uuid4().hex
            # Local history is bounded and never includes cookies or passenger data.
            if len(self.jobs) >= 40:
                del self.jobs[next(iter(self.jobs))]
            self.jobs[job_id] = {"status": "queued", "progress": 0, "message": "이전에 조회한 결과를 확인하고 있어요."}
            self.active = job_id
            threading.Thread(target=self._run, args=(job_id, params), daemon=True).start()
            return job_id

    def start_handoff(self, selection):
        with self.lock:
            if self.active:
                raise AppError("BUSY", "다른 조회나 자동 입력을 진행하고 있어요. 끝난 뒤 다시 눌러 주세요.", 409)
            if self.restricted or self.store.block_path.exists():
                raise AppError("ACCESS_RESTRICTED", "접속이 제한되어 지금은 자동 입력을 할 수 없어요. 저장된 결과를 보거나 대한항공 홈페이지에서 확인해 주세요.", 409)
            job_id = uuid.uuid4().hex
            if len(self.jobs) >= 40:
                del self.jobs[next(iter(self.jobs))]
            self.jobs[job_id] = {"status": "queued", "progress": 0, "message": "선택한 날짜로 대한항공을 열고 있어요."}
            self.active = job_id
            threading.Thread(target=self._run_handoff, args=(job_id, dict(selection)), daemon=True).start()
            return job_id

    def restrict(self, code):
        with self.lock:
            self.restricted = True
            try:
                self.store.write_json(self.store.block_path, {"code": code, "at": utc_now().isoformat()})
            except OSError:
                pass

    def _run_handoff(self, job_id, selection):
        try:
            if self.restricted or self.store.block_path.exists():
                raise handoff_error("ACCESS_RESTRICTED")
            self.update(job_id, status="running", message="새 Chrome 창에 선택한 조건을 입력하고 있어요.")
            result = self.handoff(selection)
            if not isinstance(result, dict) or result.get("kind") != "airline-handoff" or result.get("stage") not in HANDOFF_MESSAGES or result.get("selection") != selection:
                raise handoff_error()
            safe_result = {"kind": "airline-handoff", "selection": dict(selection), "stage": result["stage"],
                           "message": HANDOFF_MESSAGES[result["stage"]]}
            self.update(job_id, status="complete", progress=100, message=safe_result["message"], result=safe_result)
        except Exception as error:
            safe_error = handoff_error(error.code if isinstance(error, AppError) else None)
            if safe_error.code in RESTRICTIONS:
                self.restrict(safe_error.code)
            self.update(job_id, status="failed", message=safe_error.message,
                        error={"code": safe_error.code, "message": safe_error.message})
        finally:
            with self.lock:
                self.active = None

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise AppError("JOB_NOT_FOUND", "조회 기록을 찾지 못했어요.", 404)
            return dict(self.jobs[job_id])

    def update(self, job_id, **fields):
        with self.lock:
            self.jobs[job_id].update(fields)

    def _run(self, job_id, params):
        fetched = set()
        try:
            legs = legs_for(params)
            for index, leg in enumerate(legs):
                value = self.store.read(leg)
                if value is not None and not self.store.stale(value):
                    continue
                if self.restricted or self.store.block_path.exists():
                    raise AppError("ACCESS_RESTRICTED", "접속이 제한되어 지금은 새로 조회할 수 없어요. 이전 결과를 보거나 대한항공 홈페이지에서 확인해 주세요.")
                self.update(job_id, status="running", progress=round(index / len(legs) * 100),
                            message="%s → %s · %s 마일리지 좌석을 확인하고 있어요." % (leg["origin"], leg["destination"], leg["month"]))
                value = self.collector(leg)
                self.store.save(value, leg)
                fetched.add(cache_key(leg))
            self.update(job_id, status="complete", progress=100, message="조회를 마쳤어요.",
                        result=self.store.result(params, fetched))
        except AppError as error:
            if error.code in RESTRICTIONS:
                self.restrict(error.code)
            self.update(job_id, status="failed", message=error.message, error={"code": error.code, "message": error.message},
                        result=self.store.result(params, fetched))
        except Exception:
            self.update(job_id, status="failed", message="조회 중 문제가 생겼어요. 이전에 저장한 결과는 그대로 남아 있어요.",
                        error={"code": "LOCAL_ERROR", "message": "조회 중 문제가 생겼어요. 이전에 저장한 결과는 그대로 남아 있어요."},
                        result=self.store.result(params, fetched))
        finally:
            with self.lock:
                self.active = None


class BusinessScanService:
    """Sweeps many origin/destination/month combinations for business-class award
    seats across Korean Air (public calendar) and Asiana (worker Chrome, no login
    needed for its public calendar). Shares SearchService's lock/active/restricted
    state so it never runs alongside a manual single-route search."""

    def __init__(self, search_service, award_service, root=ROOT):
        self.search = search_service
        self.award = award_service
        self.root = Path(root)
        self.jobs = {}
        self.cancelled = set()
        self.last_asiana_at = None
        self.unsupported_path = self.search.store.directory / "unsupported-routes.json"
        self.job_path = self.search.store.directory / "business-scan-job.json"

    def read_saved_job(self, job_id):
        """A scan lives in memory, so a restart loses the thread running it. The
        last saved snapshot still carries what it had already found."""
        try:
            saved = json.loads(self.job_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(saved, dict) or saved.get("id") != job_id:
            return None
        job = {key: value for key, value in saved.items() if key != "id"}
        if job.get("status") in ("queued", "running"):
            job["status"] = "interrupted"
            job["message"] = ("조회 프로그램이 다시 시작되어 이번 조회는 중단됐어요. "
                              "중단 전까지 찾은 결과는 아래에 남아 있어요.")
        return job

    def save_job(self, job_id, job):
        try:
            self.search.store.write_json(self.job_path, dict(job, id=job_id))
        except OSError:
            pass

    def cancel(self, job_id):
        with self.search.lock:
            if job_id not in self.jobs:
                raise AppError("JOB_NOT_FOUND", "조회 기록을 찾지 못했어요.", 404)
            if self.jobs[job_id]["status"] not in ("queued", "running"):
                return {"status": self.jobs[job_id]["status"]}
            self.cancelled.add(job_id)
            self.jobs[job_id]["message"] = "조회를 멈추고 있어요. 진행 중인 1건이 끝나면 멈춰요."
        try:
            self.award.cancel("asiana-club")
        except (SasError, AppError):
            pass
        return {"status": "cancelling"}

    def unsupported_routes(self):
        try:
            value = json.loads(self.unsupported_path.read_text(encoding="utf-8"))
            return {key for key in value.get("routes", []) if isinstance(key, str)}
        except (OSError, ValueError, TypeError, AttributeError):
            return set()

    def remember_unsupported(self, program, origin, destination):
        routes = self.unsupported_routes()
        routes.add("%s|%s|%s" % (program, origin, destination))
        try:
            self.search.store.write_json(self.unsupported_path, {"routes": sorted(routes)})
        except OSError:
            pass

    def start(self, raw):
        params = validate_business_scan_request(raw)
        legs = [{"origin": origin, "destination": destination, "month": month}
                for origin in params["origins"] for destination in params["destinations"] for month in params["months"]]
        with self.search.lock:
            if self.search.active:
                raise AppError("BUSY", "다른 조회나 자동 입력을 진행하고 있어요. 끝난 뒤 다시 눌러 주세요.", 409)
            job_id = uuid.uuid4().hex
            if len(self.jobs) >= 20:
                del self.jobs[next(iter(self.jobs))]
            self.jobs[job_id] = {"status": "queued", "progress": 0, "message": "스캔을 준비하고 있어요.",
                                  "total": len(legs) * len(params["programs"]), "completed": 0,
                                  "hits": [], "failures": []}
            self.search.active = job_id
            threading.Thread(target=self._run, args=(job_id, legs, params["programs"]), daemon=True).start()
            return job_id

    def get(self, job_id):
        with self.search.lock:
            if job_id in self.jobs:
                return dict(self.jobs[job_id])
        saved = self.read_saved_job(job_id)
        if saved is None:
            raise AppError("JOB_NOT_FOUND", "조회 기록을 찾지 못했어요.", 404)
        return saved

    def update(self, job_id, **fields):
        with self.search.lock:
            if job_id not in self.jobs:
                return
            self.jobs[job_id].update(fields)
            snapshot = dict(self.jobs[job_id])
        self.save_job(job_id, snapshot)

    def _collect_korean_air(self, leg):
        value = self.search.store.read(leg)
        if value is None or self.search.store.stale(value):
            value = collect_leg(leg, self.root)
            self.search.store.save(value, leg)
        found = []
        for row in value["dates"]:
            cabins = ["prestige"] if row.get("prestigeAward") else []
            # The public calendar prints one combined 일등석 보너스/좌석승급 marker,
            # so a first-class day is reported as such without claiming it is an award.
            if row.get("firstAwardOrUpgrade"):
                cabins.append("first")
            # One finding per cabin. Carrying both in a single entry meant the live
            # check ran for only one of them and its answer was shown for both —
            # first class at 120,000 miles appeared as an available business seat.
            for cabin in cabins:
                # The airline's own reference time travels with the finding: it is
                # hours older than our read, and treating our read as the truth is
                # what makes a seat look live when it is a daily snapshot.
                found.append({"date": row["date"], "cabins": [cabin],
                              "sourceUpdatedAt": value.get("sourceUpdatedAt"),
                              "collectedAt": value.get("collectedAt")})
        return found

    def _collect_asiana(self, leg):
        # Asiana refuses back-to-back lookups, so each one waits its turn. A slow
        # sweep that finishes beats a fast one that gets rate limited.
        if self.last_asiana_at:
            wait = ASIANA_REQUEST_INTERVAL - (time.monotonic() - self.last_asiana_at)
            while wait > 0:
                time.sleep(min(wait, 1))
                wait -= 1
        self.last_asiana_at = time.monotonic()
        payload = {"program": "asiana-club", "origin": leg["origin"], "destination": leg["destination"],
                   "month": leg["month"], "tripType": "ONE_WAY", "cabin": "business"}
        self.award.start(payload)
        for _ in range(600):
            time.sleep(1)
            job = self.award.status("asiana-club").get("job") or {}
            if job.get("status") in ("complete", "partial", "failed", "cancelled"):
                if job.get("status") in ("failed", "cancelled"):
                    code = job.get("code") or "SEARCH_FAILED"
                    raise AppError(code, "아시아나 조회를 완료하지 못했어요." if code not in RESTRICTIONS
                                    else "아시아나에서 접속을 제한했어요.")
                days = job.get("legs", [{}])[0].get("days", [])
                # Asiana's public calendar publishes economy and business only.
                found = []
                for day in days:
                    if "business" not in (day.get("cabins") or []):
                        continue
                    # Asiana publishes its own per-flight seat count, so the finding
                    # can say which flight and how many seats rather than just "yes".
                    seats = [f for f in (day.get("flights") or []) if f.get("cabin") == "business"]
                    found.append({"date": day["date"], "cabins": ["prestige"],
                                  "sourceUpdatedAt": day.get("sourceAt"), "collectedAt": day.get("observedAt"),
                                  "liveFlights": ["%s %s석" % (f["flightNumber"], f["availableSeatCount"])
                                                  for f in seats if f.get("availableSeatCount")]})
                return found
        raise AppError("COLLECTION_TIMEOUT", "아시아나 조회가 오래 걸려 중단했어요.")

    def _verify_live(self, job_id, hits, pending, refused):
        """Asks the airline's own booking search about the dates just found.

        Runs as each leg finishes rather than at the end, so a date is confirmed
        or dropped while the sweep is still going. The public calendar is a
        once-daily snapshot; this is the live answer. It needs the logged-in
        Chrome, so when that is unavailable the findings keep their calendar
        result and say the live check did not run — a seat we could not re-check
        is not a seat we know is gone."""
        for hit in pending:
            if job_id in self.cancelled:
                break
            if hit["program"] in refused:
                hit.setdefault("live", "unchecked")
                continue
            self.update(job_id, message="실시간 확인 중이에요 · %s→%s %s" % (
                hit["origin"], hit["destination"], hit["date"]))
            # A finding names one cabin. Silently picking one of several is how a
            # first-class answer once got shown as an available business seat, so
            # an ambiguous finding is left unchecked instead of guessed at.
            cabins = hit.get("cabins") or []
            if len(cabins) != 1:
                hit["live"], hit["liveCode"] = "unchecked", "AMBIGUOUS_CABIN"
                self.update(job_id, hits=list(hits))
                continue
            cabin = "first" if cabins[0] == "first" else "business"
            try:
                result = self.award.worker.call(
                    "verify", {"origin": hit["origin"], "destination": hit["destination"],
                               "date": hit["date"], "cabin": cabin},
                    program=hit["program"], timeout=180)
            except SasError as error:
                hit["live"], hit["liveCode"] = "unchecked", error.code
                self.update(job_id, hits=list(hits))
                continue
            status = result.get("status")
            if status == "available":
                hit["live"] = "available"
                hit["liveFlights"] = result.get("flights") or []
            elif status == "empty":
                hit["live"] = "gone"
            else:
                hit["live"], hit["liveCode"] = "unchecked", result.get("code") or "SEARCH_FAILED"
                # One airline refusing says nothing about the other, so only that
                # airline's later checks are retired.
                if hit["liveCode"] in ("LOGIN_REQUIRED", "ACCESS_RESTRICTED"):
                    refused.add(hit["program"])
            hit["liveCheckedAt"] = utc_now().isoformat()
            self.update(job_id, hits=list(hits))

    def _run(self, job_id, legs, programs):
        hits, failures, completed = [], [], 0
        total = len(legs) * len(programs)
        try:
            # Asiana searches run in their own windowless browser, so no visible
            # login window is opened here.
            unsupported = self.unsupported_routes()
            skipped = []
            restricted_programs = set()
            # Airlines that refused a live check; their later dates stay unchecked.
            refused = set()
            for leg in legs:
                for program in programs:
                    if job_id in self.cancelled:
                        raise StopIteration()
                    if program in restricted_programs:
                        completed += 1
                        self.update(job_id, completed=completed)
                        continue
                    route_key = "%s|%s|%s" % (program, leg["origin"], leg["destination"])
                    if route_key in unsupported:
                        completed += 1
                        if route_key not in skipped:
                            skipped.append(route_key)
                        self.update(job_id, completed=completed, skipped=list(skipped))
                        continue
                    with self.search.lock:
                        if self.search.restricted or self.search.store.block_path.exists():
                            raise AppError("ACCESS_RESTRICTED", "접속이 제한되어 지금은 새로 조회할 수 없어요.")
                    self.update(job_id, status="running", progress=round(completed / total * 100) if total else 100,
                                message="%s %s→%s · %s 확인하고 있어요." % (
                                    "대한항공" if program == "korean-air" else "아시아나",
                                    leg["origin"], leg["destination"], leg["month"]))
                    try:
                        dates = self._collect_korean_air(leg) if program == "korean-air" else self._collect_asiana(leg)
                    except AppError as leg_error:
                        if leg_error.code in RESTRICTIONS:
                            # One airline refusing us must not cancel the other's sweep.
                            if program != "asiana-club":
                                raise
                            restricted_programs.add(program)
                            failures.append({"program": program, "origin": leg["origin"],
                                              "destination": leg["destination"], "month": leg["month"],
                                              "code": leg_error.code})
                            completed += 1
                            self.update(job_id, completed=completed, failures=list(failures))
                            continue
                        if leg_error.code in UNSUPPORTED_ROUTE_CODES:
                            self.remember_unsupported(program, leg["origin"], leg["destination"])
                            unsupported.add(route_key)
                            if route_key not in skipped:
                                skipped.append(route_key)
                        else:
                            failures.append({"program": program, "origin": leg["origin"], "destination": leg["destination"],
                                              "month": leg["month"], "code": leg_error.code})
                        completed += 1
                        self.update(job_id, completed=completed, failures=list(failures), skipped=list(skipped))
                        continue
                    found_at = utc_now().isoformat()
                    fresh = [{"program": program, "origin": leg["origin"], "destination": leg["destination"],
                              "month": leg["month"], "date": found["date"],
                              "cabins": found["cabins"], "foundAt": found_at,
                              "sourceUpdatedAt": found.get("sourceUpdatedAt"),
                              "collectedAt": found.get("collectedAt"),
                              "liveFlights": found.get("liveFlights")} for found in dates]
                    hits.extend(fresh)
                    completed += 1
                    self.update(job_id, completed=completed, hits=list(hits))
                    # Confirm or drop these dates now, while the sweep continues,
                    # so the screen never shows a seat that is already gone.
                    self._verify_live(job_id, hits, fresh, refused)
            live = len([h for h in hits if h.get("live") == "available"])
            gone = len([h for h in hits if h.get("live") == "gone"])
            blocked = {h.get("liveCode") for h in hits if h.get("live") == "unchecked"}
            if "LOGIN_REQUIRED" in blocked:
                live_note = (" 실시간 확인은 대한항공 로그인이 필요해요 — 아래 '대한항공 로그인·예약 열기'에서"
                             " 로그인한 뒤 다시 조회하면 지금 예약 가능한 자리만 보여드려요.")
            elif "ACCESS_RESTRICTED" in blocked:
                live_note = " 대한항공이 조회를 제한해 실시간 확인을 하지 못했어요."
            elif live or gone:
                live_note = " 실시간 확인 결과 %d건 남아 있고 %d건은 이미 나갔어요." % (live, gone)
            else:
                live_note = ""
            self.update(job_id, status="complete", progress=100,
                        message="스캔을 마쳤어요. 비즈니스석 %d건을 찾았어요.%s%s%s" % (
                            len(hits), live_note,
                            " 미취항 노선 %d개는 건너뛰었어요." % len(skipped) if skipped else "",
                            " 아시아나는 접속이 제한되어 건너뛰었어요." if "asiana-club" in restricted_programs else ""),
                        hits=hits, failures=failures, skipped=skipped)
        except StopIteration:
            self.update(job_id, status="cancelled", message="조회를 멈췄어요. 지금까지 찾은 결과는 그대로 남아 있어요.",
                        hits=hits, failures=failures, skipped=skipped)
        except AppError as error:
            if error.code in RESTRICTIONS:
                self.search.restrict(error.code)
            self.update(job_id, status="failed", message=error.message,
                        error={"code": error.code, "message": error.message}, hits=hits, failures=failures)
        except Exception:
            self.update(job_id, status="failed", message="스캔 중 문제가 생겼어요. 지금까지 찾은 결과는 남아 있어요.",
                        error={"code": "LOCAL_ERROR", "message": "스캔 중 문제가 생겼어요."}, hits=hits, failures=failures)
        finally:
            with self.search.lock:
                self.search.active = None
                self.cancelled.discard(job_id)


RELEASE_HOUR = 9  # Both airlines open the far edge of their window at 09:00 KST.
# How far ahead each airline sells. Measured against the live calendars on
# 2026-09-20: Korean Air's last open date was +360 days, Asiana's +364.
RELEASE_WINDOWS = {"korean-air": 360, "asiana-club": 364}
RELEASE_WINDOW_DAYS = RELEASE_WINDOWS["korean-air"]
RELEASE_PATH = ROOT / "config" / "release-watch.json"


def release_date_for(target, program="korean-air"):
    """The morning a target date becomes bookable on that airline."""
    return target - timedelta(days=RELEASE_WINDOWS.get(program, RELEASE_WINDOW_DAYS))


def validate_release_request(raw, today=None):
    if not isinstance(raw, dict):
        raise AppError("INVALID_INPUT", "예매 대기 조건을 확인해 주세요.")
    params = {}
    for field, label in (("origin", "출발지"), ("destination", "도착지")):
        value = str(raw.get(field, "")).strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", value):
            raise AppError("INVALID_AIRPORT", "%s 공항 코드를 확인해 주세요." % label)
        params[field] = value
    if params["origin"] == params["destination"]:
        raise AppError("SAME_AIRPORT", "출발지와 도착지를 다르게 선택해 주세요.")
    value = raw.get("date")
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise AppError("INVALID_DATE", "타려는 날짜를 선택해 주세요.")
    try:
        target = date.fromisoformat(value)
    except ValueError:
        raise AppError("INVALID_DATE", "날짜를 올바르게 선택해 주세요.")
    cabin = raw.get("cabin", "business")
    if cabin not in ("business", "first"):
        raise AppError("INVALID_CABIN", "비즈니스 또는 일등석을 선택해 주세요.")
    program = raw.get("program", "korean-air")
    if program not in BUSINESS_SCAN_PROGRAMS:
        raise AppError("INVALID_INPUT", "항공사를 선택해 주세요.")
    # Asiana publishes economy and business only.
    if program == "asiana-club" and cabin == "first":
        raise AppError("INVALID_CABIN", "아시아나는 일등석 보너스를 제공하지 않아요.")
    params["program"] = program
    account = str(raw.get("account", "default")).strip() or "default"
    if not re.fullmatch(r"[A-Za-z0-9-]{1,24}", account):
        raise AppError("INVALID_INPUT", "계정 이름은 영문·숫자·하이픈 24자 이내로 지어 주세요.")
    params["account"] = account
    params["label"] = str(raw.get("label", "")).strip()[:40]

    today = today or datetime.now(SEOUL).date()
    opens_on = release_date_for(target, program)
    if opens_on < today:
        raise AppError("ALREADY_OPEN", "이미 예매가 열린 날짜예요. 바로 검색해서 확인해 주세요.")
    params.update(date=value, cabin=cabin, windowDays=RELEASE_WINDOWS[program],
                  opensOn=opens_on.isoformat(),
                  opensAt=datetime.combine(opens_on, dtime(RELEASE_HOUR), SEOUL).isoformat())
    return params


class ReleaseWatchService:
    """Waits for the 09:00 KST release of one date and gets to the booking screen.

    Seats for a newly opened day are taken within minutes, so this starts polling
    just before the hour and keeps asking until the airline answers. It selects the
    fare and stops there: paying is the user's to do."""

    POLL_SECONDS = 3
    # Filling three tabs takes about fifteen seconds, so the standby wakes well
    # before the hour. Arriving at 09:00 with the forms still filling would undo
    # the whole point of preparing them.
    LEAD_SECONDS = 90
    GIVE_UP_SECONDS = 15 * 60
    LOGIN_CHECK_SECONDS = 10 * 60
    ARMED_TABS = 3
    RETRY_TABS = 1

    MAX_WATCHES = 6
    TAB_BUDGET = 6  # Total tabs fired at 09:00 across every standby.

    def __init__(self, award_service, root=ROOT):
        self.award = award_service
        self.root = Path(root)
        self.lock = threading.RLock()
        self.jobs = {}       # id -> job dict
        self.threads = {}    # id -> Thread
        self.stops = {}      # id -> Event

    def tabs_per_watch(self):
        """Split a fixed tab budget across the live standbys rather than letting
        each take three — nine tabs firing at once strains the mac and looks like
        a burst from one address to the airline."""
        with self.lock:
            live = max(1, len([j for j in self.jobs.values() if j.get("status") in ("waiting", "sniping")]))
        return max(1, min(self.ARMED_TABS, self.TAB_BUDGET // live))

    def read_all(self):
        with self.lock:
            return [dict(job) for job in self.jobs.values()]

    def read(self):
        """Backwards-compatible single view: the first live standby, if any."""
        jobs = self.read_all()
        if jobs:
            return jobs[0]
        # A standby that was waiting when the program stopped is not still waiting.
        # Saying so is what keeps someone from trusting it through 9am.
        for saved in self.read_saved():
            if saved.get("status") in ("waiting", "sniping"):
                saved["status"] = "interrupted"
                saved["message"] = ("프로그램이 다시 시작되어 예매 대기가 끊겼어요. "
                                    "9시에 잡으려면 다시 신청해 주세요.")
            return saved
        return None

    def read_saved(self):
        try:
            saved = json.loads((self.root / "data" / "local" / "release-watch-job.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if isinstance(saved, dict):
            saved = [saved]
        return [job for job in saved if isinstance(job, dict)]

    def save(self):
        try:
            (self.root / "data" / "local").mkdir(parents=True, exist_ok=True)
            (self.root / "data" / "local" / "release-watch-job.json").write_text(
                json.dumps(self.read_all(), ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def update(self, watch_id, **fields):
        with self.lock:
            job = self.jobs.get(watch_id)
            if not job:
                return
            job.update(fields)
        self.save()

    def start(self, raw):
        params = validate_release_request(raw)
        watch_id = uuid.uuid4().hex[:12]
        with self.lock:
            live = [j for j in self.jobs.values() if j.get("status") in ("waiting", "sniping")]
            if len(live) >= self.MAX_WATCHES:
                raise AppError("TOO_MANY_WATCHES",
                               "동시에 기다릴 수 있는 건 최대 %d건이에요." % self.MAX_WATCHES, 409)
            # The same account cannot chase two dates at once: arming one replaces
            # the other's prepared tabs in that profile.
            clash = next((j for j in live if j["account"] == params["account"]
                          and j["program"] == params["program"]
                          and (j["date"], j["origin"], j["destination"]) != (params["date"], params["origin"], params["destination"])), None)
            if clash:
                raise AppError("ACCOUNT_BUSY",
                               "'%s' 계정은 이미 %s %s→%s 를 기다리고 있어요. 다른 계정을 쓰거나 먼저 멈춰 주세요."
                               % (params["account"], clash["date"], clash["origin"], clash["destination"]), 409)
            self.stops[watch_id] = threading.Event()
            self.jobs[watch_id] = dict(params, id=watch_id, status="waiting", attempts=0,
                                       message="%s 오전 9시에 %s 자리가 열리면 바로 잡을게요." % (params["opensOn"], params["date"]),
                                       startedAt=utc_now().isoformat())
            thread = threading.Thread(target=self._run, args=(watch_id, dict(params)), daemon=True)
            self.threads[watch_id] = thread
            thread.start()
            job = dict(self.jobs[watch_id])
        self.save()
        return job

    def cancel(self, watch_id=None):
        with self.lock:
            targets = [watch_id] if watch_id else list(self.jobs)
            for target in targets:
                stop = self.stops.get(target)
                if stop:
                    stop.set()
                job = self.jobs.get(target)
                if job and job.get("status") in ("waiting", "sniping"):
                    job.update(status="cancelled", message="예매 대기를 멈췄어요.")
        self.save()
        return {"status": "cancelled", "cancelled": len(targets)}

    def _run(self, watch_id, params):
        try:
            opens_at = datetime.fromisoformat(params["opensAt"]) - timedelta(seconds=self.LEAD_SECONDS)
            next_check = 0.0
            while not self.stops[watch_id].is_set():
                remaining = (opens_at - datetime.now(SEOUL)).total_seconds()
                if remaining <= 0:
                    break
                # The airline's session expires on its own. Finding that out at
                # 09:00 is finding out too late, so it is checked while there is
                # still time to sign in again.
                warning = ""
                if time.monotonic() >= next_check:
                    next_check = time.monotonic() + self.LOGIN_CHECK_SECONDS
                    try:
                        browser = self.award.worker.call("confirm-login", timeout=90, program=params["program"])
                        if not browser.get("authenticated"):
                            warning = " ⚠️ %s 로그인이 풀렸어요 — 9시 전에 다시 로그인해 주세요." % (
                                "대한항공" if params["program"] == "korean-air" else "아시아나")
                            airline = "대한항공" if params["program"] == "korean-air" else "아시아나"
                            self._notify_text("⚠️ %s 로그인이 풀렸어요.\n%s 오전 9시 예매 대기가 예정되어 있으니 그 전에 다시 로그인해 주세요."
                                              % (airline, params["opensOn"]))
                    except SasError:
                        warning = " (로그인 상태를 확인하지 못했어요.)"
                self.update(watch_id, status="waiting", loginWarning=bool(warning),
                            message="%s 오전 9시까지 %d분 남았어요.%s" % (
                                params["opensOn"], max(1, int(remaining // 60)), warning))
                time.sleep(min(remaining, 30))
            if self.stops[watch_id].is_set():
                return

            # Fill the form before the hour so the release itself costs one click.
            program = params["program"]
            query = {"origin": params["origin"], "destination": params["destination"],
                     "date": params["date"], "cabin": params["cabin"], "hold": True,
                     "account": params["account"]}
            armed = False
            try:
                tabs = self.tabs_per_watch()
                self.update(watch_id, status="sniping", message="조회 화면 %d개를 미리 채워두고 있어요." % tabs)
                ready = self.award.worker.call("arm", dict(query, tabs=tabs),
                                               program=program, timeout=240)
                armed = ready.get("status") == "armed"
            except SasError as error:
                self.update(watch_id, message="미리 준비하지 못했어요 (%s). 정각에 처음부터 조회할게요." % error.code)

            # Arming takes time, so hold here until the hour itself. Firing early
            # only burns a prepared tab on seats that do not exist yet.
            release_at = datetime.fromisoformat(params["opensAt"])
            while not self.stops[watch_id].is_set():
                countdown = (release_at - datetime.now(SEOUL)).total_seconds()
                if countdown <= 0:
                    break
                self.update(watch_id, status="sniping",
                            message="준비 완료. 9시까지 %d초 남았어요." % int(countdown))
                time.sleep(min(countdown, 1))
            if self.stops[watch_id].is_set():
                return

            deadline = time.monotonic() + self.GIVE_UP_SECONDS
            attempts = 0
            while not self.stops[watch_id].is_set() and time.monotonic() < deadline:
                attempts += 1
                self.update(watch_id, status="sniping", attempts=attempts,
                            message="자리를 확인하고 있어요 (%d번째)." % attempts)
                try:
                    if armed:
                        result = self.award.worker.call("fire", query, program=program, timeout=120)
                        if result.get("code") == "NOT_ARMED":
                            armed = False
                            continue
                    else:
                        result = self.award.worker.call("verify", query, program=program, timeout=120)
                except SasError as error:
                    self.update(watch_id, message="조회에 실패했어요 (%s). 다시 시도해요." % error.code)
                    armed = False
                    time.sleep(self.POLL_SECONDS)
                    continue
                if result.get("status") == "available":
                    self.update(watch_id, status="found", flights=result.get("flights") or [],
                                held=bool(result.get("held")), foundAt=utc_now().isoformat(),
                                message=("자리를 찾았어요! 좌석까지 선택해 두었으니 Chrome에서 결제만 진행해 주세요."
                                         if result.get("held") else
                                         "자리를 찾았어요! Chrome 예매 화면에서 좌석을 선택하고 결제해 주세요."))
                    self._notify(params, result)
                    return
                if result.get("code") in RESTRICTIONS:
                    airline = "대한항공" if program == "korean-air" else "아시아나"
                    self.update(watch_id, status="failed", message="%s가 조회를 제한하거나 로그인이 풀렸어요. 로그인을 확인해 주세요." % airline)
                    return
                # Submitting consumed the prepared page, so refill it during the
                # wait rather than paying for the whole form on the next attempt.
                if armed:
                    # Refill one tab, not three: a retry wants to be back in the
                    # air quickly, and the crowd has already thinned by then.
                    try:
                        armed = self.award.worker.call("arm", dict(query, tabs=self.RETRY_TABS),
                                                       program=program, timeout=120).get("status") == "armed"
                    except SasError:
                        armed = False
                time.sleep(self.POLL_SECONDS)
            if not self.stops[watch_id].is_set():
                self.update(watch_id, status="missed",
                            message="9시 이후 %d분 동안 %s 자리를 찾지 못했어요." % (self.GIVE_UP_SECONDS // 60, params["date"]))
        except Exception:
            self.update(watch_id, status="failed", message="예매 대기 중 문제가 생겼어요.")

    def _notify_text(self, text):
        token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
        if not token or not chat:
            return
        try:
            request = Request("https://api.telegram.org/bot%s/sendMessage" % token,
                              data=json.dumps({"chat_id": chat, "text": text}).encode("utf-8"),
                              headers={"Content-Type": "application/json"})
            urlopen(request, timeout=15).read()
        except (URLError, OSError, ValueError):
            pass

    def _notify(self, params, result):
        token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
        if not token or not chat:
            return
        text = "🎯 [%s] %s→%s %s %s 자리가 열렸어요!\n%s\n\nChrome 예매 화면이 열려 있어요 — 결제만 진행해 주세요." % (
            "대한항공" if params["program"] == "korean-air" else "아시아나",
            params["origin"], params["destination"], params["date"],
            "비즈니스" if params["cabin"] == "business" else "일등석",
            "\n".join(result.get("flights") or []))
        try:
            request = Request("https://api.telegram.org/bot%s/sendMessage" % token,
                              data=json.dumps({"chat_id": chat, "text": text}).encode("utf-8"),
                              headers={"Content-Type": "application/json"})
            urlopen(request, timeout=15).read()
        except (URLError, OSError, ValueError):
            pass


def app_config():
    today = datetime.now(SEOUL).date()
    minimum, maximum = month_bounds(today)
    default = "2026-11" if minimum <= "2026-11" <= maximum else minimum
    return {"today": today.isoformat(), "minMonth": minimum, "maxMonth": maximum,
            "defaults": {"origin": "ICN", "destination": "SIN", "month": default, "returnMonth": default,
                         "cabin": "prestige", "tripType": "ONE_WAY"}, "sourceUrl": SOURCE_URL}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, service=None):
        self.service = service or SearchService()
        self.sas_store = SasStore(self.service.store.root)
        self.sas_service = SasService(self.service.store.root, self.sas_store)
        self.award_service = AwardService(self.service.store.root, self.sas_service)
        self.business_scan_service = BusinessScanService(self.service, self.award_service)
        self.release_watch_service = ReleaseWatchService(self.award_service)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalAwardViewer/1.0"

    def log_message(self, *_args):
        pass

    def allowed(self, mutation=False):
        port = self.server.server_port
        hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
        if self.headers.get("Host") not in hosts:
            raise AppError("LOCAL_ONLY", "이 프로그램은 내 컴퓨터에서만 사용할 수 있어요.", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise AppError("LOCAL_ONLY", "다른 사이트에서는 이 프로그램을 사용할 수 없어요.", 403)
        if mutation and self.headers.get("Origin") not in {"http://" + host for host in hosts}:
            raise AppError("LOCAL_ONLY", "마일리지 조회 화면에서 버튼을 눌러 주세요.", 403)

    def respond(self, value, status=200, html=False):
        body = value if html else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8" if html else "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self.allowed()
            target = urlparse(self.path)
            if target.path == "/":
                self.respond((ROOT / "local_web" / "index.html").read_bytes(), html=True)
            elif target.path == "/award-ui.js":
                body = (ROOT / "local_web" / "award-ui.js").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            elif target.path == "/api/awards/status":
                program = parse_qs(target.query).get("program", [""])[-1]
                self.respond(self.server.award_service.status(program))
            elif target.path == "/sas-ui.js":
                body = (ROOT / "local_web" / "sas-ui.js").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
            elif target.path == "/api/sas/status":
                self.respond(self.server.sas_service.status())
            elif target.path == "/api/sas-results":
                self.respond({"results": self.server.sas_store.list()})
            elif target.path == "/api/health":
                self.respond({"app": "korean-air-local-award-viewer", "status": "ok"})
            elif target.path == "/api/config":
                self.respond(app_config())
            elif target.path == "/api/routes":
                self.respond(read_route_catalog(self.server.service.store.root))
            elif target.path == "/api/cache":
                query = parse_qs(target.query)
                params = validate_request({key: values[-1] for key, values in query.items()})
                self.respond(self.server.service.store.result(params))
            elif re.fullmatch(r"/api/jobs/[a-f0-9]{32}", target.path):
                self.respond(self.server.service.get(target.path.rsplit("/", 1)[-1]))
            elif target.path == "/api/flight-hours":
                try:
                    self.respond(json.loads((ROOT / "config" / "flight-hours.json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    raise AppError("FLIGHT_HOURS_UNAVAILABLE", "비행시간 정보를 불러오지 못했어요.", 503)
            elif target.path == "/api/release-watch":
                self.respond({"jobs": self.server.release_watch_service.read_all(),
                              "job": self.server.release_watch_service.read(),
                              "today": datetime.now(SEOUL).date().isoformat(),
                              "windows": RELEASE_WINDOWS, "releaseHour": RELEASE_HOUR})
            elif target.path == "/api/watches":
                self.respond(dict(read_watches(), sync=watches_sync_state()))
            elif target.path == "/api/watches/cloud":
                self.respond(cloud_runs())
            elif re.fullmatch(r"/api/business-scan/jobs/[a-f0-9]{32}", target.path):
                self.respond(self.server.business_scan_service.get(target.path.rsplit("/", 1)[-1]))
            elif target.path in ("/business-scan-ui.js", "/watches-ui.js"):
                body = (ROOT / "local_web" / target.path.lstrip("/")).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
            else:
                raise AppError("NOT_FOUND", "페이지를 찾을 수 없어요.", 404)
        except SasError as error:
            self.respond({"error": {"code": error.code, "message": "조회용 Chrome과 입력 조건을 확인해 주세요."}}, 400)
        except AppError as error:
            self.respond({"error": {"code": error.code, "message": error.message}}, error.status)

    def do_POST(self):
        try:
            self.allowed(mutation=True)
            if self.path not in ("/api/search", "/api/business-scan", "/api/business-scan/cancel",
                                 "/api/watches/save", "/api/watches/delete", "/api/watches/sync",
                                 "/api/open-booking", "/api/open-airline",
                                 "/api/release-watch/start", "/api/release-watch/cancel", "/api/open-account", "/api/sas/open", "/api/sas/search", "/api/sas/cancel", "/api/awards/open", "/api/awards/confirm-login", "/api/awards/search", "/api/awards/cancel"):
                raise AppError("NOT_FOUND", "요청한 기능을 찾을 수 없어요.", 404)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                raise AppError("INVALID_INPUT", "검색 조건을 확인해 주세요.", 415)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    raise ValueError()
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
            except (ValueError, UnicodeError):
                raise AppError("INVALID_INPUT", "검색 조건을 확인해 주세요.")
            if self.path.startswith("/api/awards/"):
                if not isinstance(payload, dict): raise SasError("INVALID_QUERY")
                program = payload.get("program")
                if self.path.endswith("/open"): result = self.server.award_service.open(program)
                elif self.path.endswith("/confirm-login"): result = self.server.award_service.confirm_login(program)
                elif self.path.endswith("/cancel"): result = self.server.award_service.cancel(program)
                else: result = self.server.award_service.start(payload)
                self.respond(result)
                return
            if self.path.startswith("/api/sas/"):
                if self.path == "/api/sas/open":
                    result = self.server.sas_service.open()
                elif self.path == "/api/sas/cancel":
                    result = self.server.sas_service.cancel()
                else:
                    if not isinstance(payload, dict):
                        raise SasError("INVALID_QUERY")
                    result = self.server.sas_service.start(payload.get("items"))
                self.respond(result)
                return
            if self.path == "/api/open-account":
                self.respond(open_account_page(payload))
                return
            if self.path == "/api/business-scan":
                self.respond({"jobId": self.server.business_scan_service.start(payload)}, 202)
                return
            if self.path == "/api/release-watch/start":
                self.respond({"job": self.server.release_watch_service.start(payload)}, 202)
                return
            if self.path == "/api/release-watch/cancel":
                watch_id = payload.get("id") if isinstance(payload, dict) else None
                if watch_id is not None and (not isinstance(watch_id, str) or not re.fullmatch(r"[a-f0-9]{12}", watch_id)):
                    raise AppError("INVALID_INPUT", "멈출 대기를 찾지 못했어요.")
                self.respond(self.server.release_watch_service.cancel(watch_id))
                return
            if self.path == "/api/open-booking":
                booking = booking_url(payload)
                # Prefer the browser the user signed into: the booking page then
                # opens already logged in, as a tab rather than another window.
                try:
                    opened = self.server.award_service.worker.call(
                        "open-url", {"url": booking["url"], "account": booking["account"]},
                        program=booking["program"], timeout=60)
                    booking["openedIn"] = "app" if opened.get("status") == "opened" else "chrome"
                except SasError:
                    booking["openedIn"] = "chrome"
                if booking["openedIn"] != "app":
                    open_in_chrome(booking["url"])
                self.respond(booking)
                return
            if self.path == "/api/watches/save":
                watch = validate_watch(payload)
                watches = [w for w in read_watches()["watches"] if w.get("id") != watch["id"]]
                if len(watches) >= 40:
                    raise AppError("TOO_MANY_WATCHES", "알림 신청은 최대 40개까지 만들 수 있어요.")
                watches.append(watch)
                save_watches(watches)
                self.respond({"watch": watch, "watches": watches, "sync": watches_sync_state()})
                return
            if self.path == "/api/watches/delete":
                identifier = payload.get("id") if isinstance(payload, dict) else None
                if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{12}", identifier):
                    raise AppError("INVALID_INPUT", "삭제할 알림 신청을 찾지 못했어요.")
                watches = [w for w in read_watches()["watches"] if w.get("id") != identifier]
                save_watches(watches)
                self.respond({"watches": watches, "sync": watches_sync_state()})
                return
            if self.path == "/api/watches/sync":
                self.respond(dict(sync_watches_to_github(), sync=watches_sync_state()))
                return
            if self.path == "/api/business-scan/cancel":
                job_id = payload.get("jobId") if isinstance(payload, dict) else None
                if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
                    raise AppError("INVALID_INPUT", "멈출 조회를 찾지 못했어요.")
                self.respond(self.server.business_scan_service.cancel(job_id))
                return
            if self.path == "/api/open-airline":
                selection = validate_handoff_request(payload)
                job_id = self.server.service.start_handoff(selection)
            else:
                params = validate_request(payload)
                job_id = self.server.service.start(params)
            self.respond({"jobId": job_id}, 202)
        except SasError as error:
            self.respond({"error": {"code": error.code, "message": "조회용 Chrome과 입력 조건을 확인해 주세요."}}, 400)
        except AppError as error:
            self.respond({"error": {"code": error.code, "message": error.message}}, error.status)


def main():
    arguments = argparse.ArgumentParser(description="마일리지 있는 날 — 로컬 개인 조회")
    arguments.add_argument("--port", type=int, default=8765)
    arguments.add_argument("--open", action="store_true", help="기본 브라우저에서 화면 열기")
    args = arguments.parse_args()
    if not 1024 <= args.port <= 65535:
        arguments.error("포트는 1024~65535 범위여야 합니다.")
    try:
        server = LocalServer(("127.0.0.1", args.port))
    except OSError:
        arguments.exit(1, "이미 사용 중인 포트입니다. --port 8766처럼 다른 포트를 선택해 주세요.\n")
    url = "http://127.0.0.1:%d" % args.port
    print("마일리지 있는 날: %s\n종료: Ctrl+C\n화면을 여는 것만으로 항공사에 새 조회를 하지 않습니다." % url, flush=True)
    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n로컬 화면을 종료했습니다.")
    finally:
        server.award_service.close()
        server.sas_service.close()
        server.server_close()


if __name__ == "__main__":
    main()
