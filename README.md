# Telegram Ticket Alert Bot

بات تلگرامی هشدار قیمت بلیط برای هواپیما، قطار و اتوبوس.

## قابلیت‌ها

- ساخت هشدار از داخل تلگرام با /newalert
- انتخاب نوع سفر: هواپیما، قطار، اتوبوس
- انتخاب مبدا، مقصد، بازه تاریخ و تعداد مسافر
- امکان شروع هشدار جدید یا دیدن هشدارهای من در همه مراحل ثبت
- حذف خودکار پیام‌های بات بعد از DELETE_MESSAGES_AFTER_SECONDS ثانیه
- حالت مبلغ مشخص: اگر قیمت از عدد کاربر کمتر شد پیام می‌دهد
- حالت هوشمند: تاریخچه قیمت را نگه می‌دارد و وقتی قیمت نسبت به میانگین تاریخی افت معنادار داشت پیام می‌دهد
- چند provider پشتیبان برای APIها؛ اگر یک منبع fail شود منابع بعدی تست می‌شوند
- ذخیره هشدارها و تاریخچه قیمت در پوشه data/

## راه‌اندازی

~~~bash
npm install
cp .env.example .env
~~~

سپس مقدارهای اصلی را در .env تنظیم کن:

~~~bash
BOT_TOKEN=telegram-bot-token
CHECK_INTERVAL_MINUTES=30
SMART_DROP_PERCENT=20
SMART_MIN_HISTORY=6
NOTIFY_COOLDOWN_MINUTES=180
~~~

بعد اجرا:

~~~bash
npm start
~~~

## دستورهای تلگرام

- /start معرفی کوتاه بات
- /newalert ساخت هشدار جدید
- /alerts نمایش هشدارهای همین چت
- /stopalert <id> غیرفعال کردن هشدار

## Providerها

فایل config/providers.json لیست APIهای قابل استفاده را نگه می‌دارد. هر provider می‌تواند برای یکی یا چند نوع سفر فعال شود:

~~~json
{
  "name": "provider-name",
  "enabled": true,
  "transports": ["flight", "train", "bus"],
  "responsePath": "items",
  "request": {
    "method": "GET",
    "url": "https://example.com/api?origin={origin}&destination={destination}&date={date}",
    "headers": {
      "Accept": "application/json"
    }
  }
}
~~~

متغیرهای قابل استفاده در URL، body و headers:

- {transport}
- {origin}
- {destination}
- {date}
- {passengers}
- هر env مثل {SNAPPTRIP_FLIGHT_API_URL}

Providerهای آماده برای Alibaba، FlyToday، Safarmarket، Utravs، MrBilit و SnappTrip در فایل config/providers.json آمده‌اند.

فعلاً providerهای نمونه disable هستند تا endpoint تاییدنشده باعث اسپم یا خطای پشت‌سرهم نشود. بعد از تایید هر API، فقط enabled را true کن.

## سرویس systemd

فایل سرویس پیشنهادی:

~~~ini
[Unit]
Description=Telegram Ticket Alert Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/Ticket_Alerting_TelegramBot
EnvironmentFile=/root/Ticket_Alerting_TelegramBot/.env
ExecStart=/usr/bin/node /root/Ticket_Alerting_TelegramBot/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
~~~

بعد از تنظیم .env:

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now ticket-alert-bot.service
~~~
