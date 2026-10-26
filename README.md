# Phone Farm — nuôi acc TikTok theo niche

Điều khiển nhiều iPhone thật để **nuôi acc TikTok theo niche**. Mỗi phiên, bot search keyword hoặc hashtag của niche, lướt các video trong kết quả và like/save như người thật. Nếu bật lọc niche, bot đọc caption bằng OCR và chỉ tương tác với video đúng niche. Cuối phiên, bot lướt thêm tab For You để kiểm tra thuật toán đã đẩy đúng niche chưa.

Fork từ [phone-farm-ios](https://gethandler.ai/ios-farm), giản lược lại:

- **SQLite** (một file `farm.db`) thay cho PostgreSQL + pg-boss. Không cần Docker.
- **1 lệnh cài, 1 lệnh chạy.**
- **Web 1 trang**: máy đang cắm, danh sách acc, niche (keywords) của từng acc.
- Vẫn giữ luồng **đăng video** (`npm run post`) để dùng sau.

## Cài đặt (1 lệnh)

Cần: máy **Mac** có **Xcode**, **Node.js 22+**, iPhone đã bật Developer Mode, và một Apple ID (team) để ký WebDriverAgent.

```sh
npm run setup
```

Lệnh này làm 4 việc: cài package, tạo `.env` từ `.env.example`, cài driver Appium XCUITest, và kiểm tra Xcode. Chạy lại nhiều lần cũng an toàn.

Sau đó mở `.env` và điền `XCODE_ORG_ID`: đây là Team ID gồm 10 ký tự, xem ở Xcode → Settings → Accounts.

## Chạy (1 lệnh)

```sh
npm start
```

Lệnh này khởi động Appium, trình giám sát WebDriverAgent, bộ lập lịch nuôi acc và dashboard, rồi in ra địa chỉ:

```
Phone Farm đang chạy
  Dashboard: http://127.0.0.1:2610
  Dữ liệu:   farm.db
  Log:       logs/
Nhấn Ctrl+C để dừng.
```

Trình duyệt **không** tự mở; bạn tự mở địa chỉ trên. Nhấn Ctrl+C để dừng tất cả.

## Dùng dashboard

**Trang chính** có 2 phần:

- **Máy đang cắm**: ảnh màn hình và trạng thái của từng máy (sẵn sàng / đang nuôi / không kết nối). Máy mới cắm vào sẽ hiện nút **Đăng ký**. Bấm vào một máy để xem màn hình trực tiếp, điều khiển, đặt passcode và căn tọa độ nút.
- **Tài khoản**: mỗi acc gắn với một máy và có niche (danh sách keyword/hashtag), giờ tự chạy, thời lượng và kết quả phiên gần nhất. Bấm **Sửa** để chỉnh, **▶ Nuôi** để chạy ngay, **■ Dừng** để dừng.

Lần đầu cho một máy:

1. Cắm iPhone qua USB, mở khóa, chọn "Tin cậy máy tính này".
2. **Đăng ký máy** trên dashboard. Trình hướng dẫn sẽ kiểm tra Xcode, quyền ký, Developer Mode và WDA.
3. Để TikTok trên iPhone ở **giao diện tiếng Anh**. Bước search đọc nhãn tiếng Anh (`For You`, `Video`, `likes`); luồng này đã được đo trên TikTok 44.x tiếng Anh.
4. Ở trang chính: **+ Thêm acc** → chọn máy, nhập `@acc` (phải đang đăng nhập trên máy đó), thêm keyword, đặt giờ chạy → **Lưu**.

### Một phiên nuôi diễn ra thế nào

1. Mở khóa máy, mở TikTok, chuyển sang acc cần nuôi bằng OCR.
2. Chọn ngẫu nhiên *N* keyword của acc (theo "Số keyword mỗi phiên").
3. Với mỗi keyword: mở lại TikTok → bấm kính lúp → gõ keyword → ở tab Top, mở ô **video** đầu tiên (đọc từ cây element) → lướt tiếp cho đến hết phần thời gian của keyword đó.
4. Lướt For You thêm vài phút (đặt 0 để bỏ qua bước này).

Mỗi video được ghi vào DB gồm caption, có khớp niche không, đã like/save chưa. Dashboard hiển thị tỉ lệ khớp niche của từng phiên.

| Thiết lập | Ý nghĩa |
| --- | --- |
| Kiểu tương tác | `Lướt nhanh` / `Bình thường` / `Tương tác nhiều`: thời gian xem và tỉ lệ like/save. |
| Lọc theo niche | Bật: video có caption không chứa keyword thì chỉ lướt qua, không like/save. So khớp bỏ dấu tiếng Việt và hiểu hashtag viết liền (`#reviewmypham`). |
| Giờ tự chạy | Giờ theo đồng hồ của máy Mac. Nếu đến giờ mà máy đang bận hoặc offline, bot thử lại trong `NURTURE_RUN_WINDOW_MINUTES` phút (mặc định 120). Mỗi khung giờ chỉ chạy một lần. |
| Bật lịch tự chạy | Tắt thì acc chỉ chạy khi bạn bấm chạy tay. |

Mỗi máy chỉ chạy một phiên tại một thời điểm, còn các máy khác nhau thì chạy song song.

## Lệnh khác

```sh
npm run nurture -- --account <id>   # chạy 1 phiên nuôi từ terminal (cần `npm start` đang chạy để có Appium + WDA)
npm run post -- manifest.json       # đăng video / lưu nháp, xem src/tiktok/post-manifest.ts
npm run wda:prepare -- --all        # ký lại WebDriverAgent cho mọi máy trong devices.json
npm run check                       # typecheck + test
```

`manifest.json` cho lệnh `post`:

```json
{
  "device": { "udid": "<udid>", "name": "iPhone 8" },
  "files": [{ "path": "/đường/dẫn/video.mp4", "name": "video.mp4", "mimeType": "video/mp4" }],
  "caption": "caption #hashtag",
  "account": "@ten_acc",
  "destination": "draft"
}
```

`destination` là `"draft"` (lưu nháp) hoặc `"publish"` (đăng công khai).

## Dữ liệu

| File | Nội dung |
| --- | --- |
| `farm.db` | SQLite: `accounts` (acc + niche + lịch), `sessions` (mỗi phiên nuôi), `interactions` (từng video đã xem). |
| `devices.json` | Máy đã đăng ký: cổng, passcode, tọa độ đã căn. Không commit lên git, quyền `0600`. |
| `logs/` | `appium.log`, `wda-service.log`, `session-<id>.log` (log từng phiên, xem được từ dashboard). |
| `.env` | Cấu hình, xem `.env.example`. |

Muốn đổi schema DB thì sửa `src/db/schema.ts`, chạy `npm run db:generate`. Migration tự áp dụng khi chạy `npm start`.

## Chuẩn bị Xcode và iPhone (làm một lần)

1. Cài Xcode từ App Store và mở một lần, rồi chạy:
   ```sh
   sudo xcodebuild -license accept
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcodebuild -runFirstLaunch
   ```
2. Xcode → Settings → Accounts: thêm Apple ID và ghi lại **Team ID** (dùng cho `XCODE_ORG_ID`). Team miễn phí chỉ đủ cho 1 máy. Nhiều máy cần team trả phí.
3. Cắm iPhone, chọn **Trust**. Trong Xcode → Window → Devices and Simulators, đợi máy hiện "Connected".
4. iOS 16+: Settings → Privacy & Security → **Developer Mode** → bật → khởi động lại máy.
5. Bước ký WDA cần login keychain đang mở khóa, nên hãy chạy từ Terminal.app hoặc remote desktop, không chạy qua SSH.

Kiểm tra: `xcrun xctrace list devices` phải liệt kê iPhone trong mục "Devices".

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| Phiên báo `WebDriverAgent is unavailable` | Máy chưa sẵn sàng. Mở trang máy xem trạng thái, xem `logs/wda-service.log`. |
| `Every keyword search failed` | Xem ảnh chụp lúc lỗi ở `logs/session-<id>-search-*.png`. Kiểm tra TikTok đang ở giao diện tiếng Anh và không có popup che màn hình. |
| Không chuyển được acc | Acc phải đang đăng nhập trên máy và tên phải khớp đúng `@handle`. |
| `wda: error … stale or corrupted` | Chạy lại `npm run wda:prepare`. Nếu vẫn lỗi, xóa `~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*`. |
| `wda: unlock-required` | Mở khóa iPhone bằng tay một lần, hoặc đặt passcode cho máy trên dashboard. |

Dashboard không có đăng nhập, nên chỉ lắng nghe ở `127.0.0.1`. Xem thêm [SECURITY.md](SECURITY.md) và [docs/coordinates.md](docs/coordinates.md) (cách thêm profile tọa độ cho đời iPhone khác).
