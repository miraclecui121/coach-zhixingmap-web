import {
  BadgeCheck,
  CalendarDays,
  Check,
  ClipboardList,
  CreditCard,
  Edit3,
  Eye,
  ExternalLink,
  HandCoins,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  QrCode,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  UserRoundCheck,
  Users,
  WalletCards,
  MessageCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Portal = "user" | "coach" | "admin";
type CoachStatus = "pending" | "approved" | "rejected";
type CoachListingStatus = "listed" | "unlisted";
type BookingStatus =
  | "reserved"
  | "payment_pending"
  | "paid"
  | "accepted"
  | "declined"
  | "completed"
  | "reviewed";
type WithdrawalStatus = "pending" | "approved" | "rejected";

type User = {
  id: string;
  name: string;
  phone: string;
  avatarColor: string;
  wechatOpenid?: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
  authProvider?: "wechat" | "dev";
  isAdmin?: boolean;
  coachId?: string;
};

type Slot = {
  id: string;
  weekday: "周三" | "周四";
  date: string;
  time: string;
  enabled: boolean;
};

type Coach = {
  id: string;
  userId: string;
  name: string;
  title: string;
  status: CoachStatus;
  listingStatus?: CoachListingStatus;
  price: number;
  intro: string;
  background: string;
  specialties: string[];
  slots: Slot[];
};

type Booking = {
  id: string;
  userId: string;
  coachId: string;
  slotId: string;
  amount: number;
  platformFee: number;
  coachIncome: number;
  status: BookingStatus;
  note?: string;
  createdAt: string;
  payment?: {
    provider: "wechat_native" | "manual_confirmation";
    state: "pending" | "paid";
    outTradeNo: string;
    codeUrl?: string;
    createdAt: string;
    paidAt?: string;
    transactionId?: string;
  };
};

type Review = {
  id: string;
  bookingId: string;
  userId: string;
  coachId: string;
  rating: number;
  content: string;
  createdAt: string;
};

type Withdrawal = {
  id: string;
  target?: "coach" | "platform";
  coachId?: string;
  amount: number;
  status: WithdrawalStatus;
  createdAt: string;
};

type Settings = {
  commissionEnabled: boolean;
  commissionRate: number;
};

type Store = {
  users: User[];
  coaches: Coach[];
  bookings: Booking[];
  reviews: Review[];
  withdrawals: Withdrawal[];
  settings: Settings;
};

type AuthConfig = {
  configured: boolean;
  missing: string[];
  scope: "snsapi_base" | "snsapi_userinfo" | string;
  allowDevLogin: boolean;
};

type PaymentConfig = {
  configured: boolean;
  missing: string[];
  allowMock: boolean;
  suggestedNotifyUrl: string;
  merchantPortalUrl: string;
  requiredEnv: string[];
};

const storageKey = "coach-marketplace-h5-store";

const seedStore: Store = {
  users: [
    {
      id: "admin",
      name: "管理员",
      phone: "admin",
      avatarColor: "#111827",
      isAdmin: true,
    },
  ],
  coaches: [],
  bookings: [],
  reviews: [],
  withdrawals: [],
  settings: {
    commissionEnabled: true,
    commissionRate: 10,
  },
};

const statusText: Record<BookingStatus, string> = {
  reserved: "待支付",
  payment_pending: "待平台确认收款",
  paid: "待教练确认",
  accepted: "教练已接受",
  declined: "教练未接受",
  completed: "已完成待评价",
  reviewed: "已评价",
};

const coachStatusText: Record<CoachStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};

const coachListingStatusText: Record<CoachListingStatus, string> = {
  listed: "已上架",
  unlisted: "未上架",
};

const portalMeta: Record<Portal, { title: string; description: string; loginText: string; icon: typeof Users }> = {
  user: {
    title: "用户预约入口",
    description: "只显示教练列表、预约支付、订单待办、评价打分。",
    loginText: "登录后可以预约教练、支付订单并完成评价。",
    icon: Users,
  },
  coach: {
    title: "教练工作台",
    description: "只显示教练申请、资料排期、订单处理、评价查看、提现。",
    loginText: "登录后可以申请成为教练，或进入已通过审核的教练工作台。",
    icon: UserRoundCheck,
  },
  admin: {
    title: "管理员后台",
    description: "只显示教练审核、上下架、分佣、订单、提现与数据备份。",
    loginText: "登录后会校验管理员权限，非管理员不会展示后台功能。",
    icon: ShieldCheck,
  },
};

function getPortalFromPath(pathname = window.location.pathname): Portal {
  const first = pathname.split("/").filter(Boolean)[0];
  if (first === "coach" || first === "admin") return first;
  return "user";
}

function getPortalPath(portal: Portal) {
  return `/${portal}`;
}

function getCoachListingStatus(coach: Coach): CoachListingStatus {
  return coach.listingStatus ?? (coach.status === "approved" ? "listed" : "unlisted");
}

function isListedCoach(coach: Coach) {
  return coach.status === "approved" && getCoachListingStatus(coach) === "listed";
}

function loadStore(): Store {
  const cached = window.localStorage.getItem(storageKey);
  if (!cached) return structuredClone(seedStore);
  try {
    return JSON.parse(cached) as Store;
  } catch {
    return structuredClone(seedStore);
  }
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatMoney(value: number) {
  return `¥${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function getSlot(coach: Coach | undefined, slotId: string) {
  return coach?.slots.find((slot) => slot.id === slotId);
}

export function App() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const storeRef = useRef(store);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const [dataMode, setDataMode] = useState<"loading" | "api" | "local">("loading");
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    configured: false,
    missing: [],
    scope: "snsapi_userinfo",
    allowDevLogin: false,
  });
  const [sessionUser, setSessionUser] = useState<User | undefined>();
  const [portal, setPortal] = useState<Portal>(() => getPortalFromPath());
  const [selectedCoachId, setSelectedCoachId] = useState("c1");
  const [paymentBookingId, setPaymentBookingId] = useState<string | null>(null);
  const [bookingError, setBookingError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", getPortalPath("user"));
    }
    const syncPortal = () => setPortal(getPortalFromPath());
    window.addEventListener("popstate", syncPortal);
    return () => window.removeEventListener("popstate", syncPortal);
  }, []);

  useEffect(() => {
    let ignore = false;
    const loadStorePromise = fetch("/api/store")
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        return response.json() as Promise<Store>;
      })
      .then((remoteStore) => {
        if (ignore) return;
        storeRef.current = remoteStore;
        setStore(remoteStore);
        setDataMode("api");
        setStoreLoaded(true);
      })
      .catch(() => {
        if (ignore) return;
        setDataMode("local");
        setStoreLoaded(true);
      });

    const loadAuthPromise = fetch("/api/auth/config")
      .then((response) => response.json() as Promise<AuthConfig>)
      .then((config) => {
        if (!ignore) setAuthConfig(config);
      })
      .catch(() => undefined);

    const loadMePromise = fetch("/api/auth/me")
      .then((response) => response.json() as Promise<{ user: User | null }>)
      .then((payload) => {
        if (!ignore) setSessionUser(payload.user ?? undefined);
      })
      .catch(() => undefined);

    void Promise.allSettled([loadStorePromise, loadAuthPromise, loadMePromise]);

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    storeRef.current = store;
    if (!storeLoaded) return;
    window.localStorage.setItem(storageKey, JSON.stringify(store));
  }, [store, storeLoaded]);

  const currentUser = sessionUser
    ? store.users.find((user) => user.id === sessionUser.id) ?? sessionUser
    : undefined;
  const approvedCoaches = useMemo(
    () =>
      store.coaches.filter(
        (coach) =>
          isListedCoach(coach) &&
          [coach.name, coach.title, coach.intro, coach.specialties.join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [query, store.coaches],
  );
  const selectedCoach =
    approvedCoaches.find((coach) => coach.id === selectedCoachId) ??
    approvedCoaches[0];

  async function persistStore(nextStore: Store) {
    window.localStorage.setItem(storageKey, JSON.stringify(nextStore));
    if (dataMode !== "api") return true;
    try {
      const response = await fetch("/api/store", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextStore),
      });
      if (!response.ok) return false;
      return true;
    } catch {
      setDataMode("local");
      return false;
    }
  }

  const setStorePatch = (updater: (draft: Store) => Store) => {
    const nextStore = updater(storeRef.current);
    storeRef.current = nextStore;
    setStore(nextStore);
    return persistStore(nextStore);
  };

  async function refreshAuthState() {
    const [storeResponse, meResponse] = await Promise.all([
      fetch("/api/store"),
      fetch("/api/auth/me"),
    ]);
    if (storeResponse.ok) {
      const remoteStore = (await storeResponse.json()) as Store;
      storeRef.current = remoteStore;
      setStore(remoteStore);
    }
    if (meResponse.ok) {
      const payload = (await meResponse.json()) as { user: User | null };
      setSessionUser(payload.user ?? undefined);
    }
  }

  async function devLogin(openid: string, nickname?: string) {
    const response = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openid, nickname }),
    });
    if (!response.ok) return;
    await refreshAuthState();
  }

  async function registerUser(name: string, phone: string) {
    const existing = store.users.find(
      (user) => user.phone === phone || user.wechatOpenid === phone,
    );
    if (existing) {
      await devLogin(phone, existing.name);
      return;
    }
    await devLogin(phone, name);
  }

  const currentCoach = currentUser
    ? store.coaches.find((coach) => coach.userId === currentUser.id)
    : undefined;
  const canUseAdminDesk = Boolean(currentUser?.isAdmin);
  const portalPath = getPortalPath(portal);

  function applyCoach(
    application: Pick<Coach, "name" | "title" | "price" | "intro" | "background" | "specialties" | "slots">,
    status: CoachStatus = "pending",
  ) {
    if (!currentUser) return;
    if (store.coaches.some((coach) => coach.userId === currentUser.id)) {
      return;
    }
    const coachId = makeId("c");
    setStorePatch((draft) => ({
      ...draft,
      users: draft.users.map((user) =>
        user.id === currentUser.id ? { ...user, coachId } : user,
      ),
      coaches: [
        ...draft.coaches,
        {
          id: coachId,
          userId: currentUser.id,
          name: application.name,
          title: application.title,
          status,
          listingStatus: "unlisted",
          price: application.price,
          intro: application.intro,
          background: application.background,
          specialties: application.specialties,
          slots: application.slots,
        },
      ],
    }));
  }

  async function bookSlot(coach: Coach, slot: Slot) {
    if (!currentUser || !isListedCoach(coach)) return;
    setBookingError("");
    const amount = coach.price;
    const platformFee = store.settings.commissionEnabled
      ? amount * (store.settings.commissionRate / 100)
      : 0;
    const booking: Booking = {
      id: makeId("b"),
      userId: currentUser.id,
      coachId: coach.id,
      slotId: slot.id,
      amount,
      platformFee,
      coachIncome: amount - platformFee,
      status: "reserved",
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    const saved = await setStorePatch((draft) => ({ ...draft, bookings: [booking, ...draft.bookings] }));
    if (saved) {
      setPaymentBookingId(booking.id);
      return;
    }
    const rolledBackStore = {
      ...storeRef.current,
      bookings: storeRef.current.bookings.filter((item) => item.id !== booking.id),
    };
    storeRef.current = rolledBackStore;
    setStore(rolledBackStore);
    window.localStorage.setItem(storageKey, JSON.stringify(rolledBackStore));
    setBookingError("预约保存失败，请刷新后重新选择时间。");
  }

  function payBooking(id: string) {
    setStorePatch((draft) => ({
      ...draft,
      bookings: draft.bookings.map((booking) =>
        booking.id === id
          ? {
              ...booking,
              status: "paid",
              payment: booking.payment
                ? { ...booking.payment, state: "paid", paidAt: new Date().toISOString() }
                : booking.payment,
            }
          : booking,
      ),
    }));
    setPaymentBookingId(null);
  }

  function confirmBookingPaid(id: string) {
    payBooking(id);
  }

  function updateBookingStatus(id: string, status: BookingStatus) {
    setStorePatch((draft) => ({
      ...draft,
      bookings: draft.bookings.map((booking) =>
        booking.id === id ? { ...booking, status } : booking,
      ),
    }));
  }

  function updateBookingNote(id: string, note: string) {
    setStorePatch((draft) => ({
      ...draft,
      bookings: draft.bookings.map((booking) =>
        booking.id === id ? { ...booking, note } : booking,
      ),
    }));
  }

  function addReview(bookingId: string, rating: number, content: string) {
    if (!currentUser) return;
    const booking = store.bookings.find((item) => item.id === bookingId);
    if (!booking) return;
    const review: Review = {
      id: makeId("r"),
      bookingId,
      userId: currentUser.id,
      coachId: booking.coachId,
      rating,
      content,
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    setStorePatch((draft) => ({
      ...draft,
      reviews: [review, ...draft.reviews],
      bookings: draft.bookings.map((item) =>
        item.id === bookingId ? { ...item, status: "reviewed" } : item,
      ),
    }));
  }

  function updateCoach(coachId: string, patch: Partial<Coach>) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId ? { ...coach, ...patch } : coach,
      ),
    }));
  }

  function addSlot(coachId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? {
              ...coach,
              slots: [
                ...coach.slots,
                {
                  id: makeId("s"),
                  weekday: "周三",
                  date: "2026-05-27",
                  time: "14:00-15:00",
                  enabled: true,
                },
              ],
            }
          : coach,
      ),
    }));
  }

  function updateSlot(coachId: string, slotId: string, patch: Partial<Slot>) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? {
              ...coach,
              slots: coach.slots.map((slot) =>
                slot.id === slotId ? { ...slot, ...patch } : slot,
              ),
            }
          : coach,
      ),
    }));
  }

  function removeSlot(coachId: string, slotId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? { ...coach, slots: coach.slots.filter((slot) => slot.id !== slotId) }
          : coach,
      ),
    }));
  }

  function requestWithdrawal(coachId: string, amount: number) {
    if (amount <= 0) return;
    setStorePatch((draft) => ({
      ...draft,
      withdrawals: [
        {
          id: makeId("w"),
          target: "coach",
          coachId,
          amount,
          status: "pending",
          createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        },
        ...draft.withdrawals,
      ],
    }));
  }

  function requestPlatformWithdrawal(amount: number) {
    if (amount <= 0) return;
    setStorePatch((draft) => ({
      ...draft,
      withdrawals: [
        {
          id: makeId("w"),
          target: "platform",
          amount,
          status: "pending",
          createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        },
        ...draft.withdrawals,
      ],
    }));
  }

  function deleteCoach(coachId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.filter((coach) => coach.id !== coachId),
      bookings: draft.bookings.filter((booking) => booking.coachId !== coachId),
      reviews: draft.reviews.filter((review) => review.coachId !== coachId),
      withdrawals: draft.withdrawals.filter((withdrawal) => withdrawal.coachId !== coachId),
    }));
    if (selectedCoachId === coachId) {
      setSelectedCoachId(store.coaches.find((coach) => coach.id !== coachId)?.id ?? "");
    }
  }

  return (
    <main>
      <Header
        portal={portal}
        portalPath={portalPath}
        currentUser={currentUser}
        dataMode={dataMode}
        authConfig={authConfig}
        onRegister={registerUser}
        onLogin={(openid) => devLogin(openid)}
        onLogout={async () => {
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
          setSessionUser(undefined);
        }}
      />

      <div className="shell single-workspace">
        {portal === "user" &&
          (currentUser ? (
            <UserDesk
              coaches={approvedCoaches}
              allCoaches={store.coaches}
              bookings={store.bookings}
              reviews={store.reviews}
              users={store.users}
              currentUser={currentUser}
              selectedCoach={selectedCoach}
              bookingError={bookingError}
              query={query}
              onQuery={setQuery}
              onSelectCoach={setSelectedCoachId}
              onBook={bookSlot}
              onPay={setPaymentBookingId}
              onNote={updateBookingNote}
              onReview={addReview}
            />
          ) : (
            <PortalLoginGate portal={portal} portalPath={portalPath} authConfig={authConfig} />
          ))}

        {portal === "coach" &&
          (currentUser ? (
            <CoachDesk
              coach={currentCoach}
              bookings={store.bookings}
              reviews={store.reviews}
              users={store.users}
              withdrawals={store.withdrawals}
              currentUser={currentUser}
              onApply={applyCoach}
              onUpdateCoach={updateCoach}
              onAddSlot={addSlot}
              onUpdateSlot={updateSlot}
              onRemoveSlot={removeSlot}
              onWithdraw={requestWithdrawal}
              onBookingStatus={updateBookingStatus}
            />
          ) : (
            <PortalLoginGate portal={portal} portalPath={portalPath} authConfig={authConfig} />
          ))}

        {portal === "admin" &&
          (currentUser ? (
            canUseAdminDesk ? (
              <AdminDesk
                store={store}
                onUpdateCoach={updateCoach}
                onDeleteCoach={deleteCoach}
                onSettings={(settings) =>
                  setStorePatch((draft) => ({
                    ...draft,
                    settings,
                  }))
                }
                onPlatformWithdraw={requestPlatformWithdrawal}
                onConfirmPayment={confirmBookingPaid}
                onWithdrawal={(id, status) =>
                  setStorePatch((draft) => ({
                    ...draft,
                    withdrawals: draft.withdrawals.map((withdrawal) =>
                      withdrawal.id === id ? { ...withdrawal, status } : withdrawal,
                    ),
                  }))
                }
              />
            ) : (
              <AccessDenied />
            )
          ) : (
            <PortalLoginGate portal={portal} portalPath={portalPath} authConfig={authConfig} />
          ))}
      </div>

      {paymentBookingId && (
        <PaymentModal
          booking={store.bookings.find((booking) => booking.id === paymentBookingId)}
          coach={store.coaches.find(
            (coach) =>
              coach.id ===
              store.bookings.find((booking) => booking.id === paymentBookingId)?.coachId,
          )}
          onClose={() => setPaymentBookingId(null)}
          onPay={() => payBooking(paymentBookingId)}
          onStoreReplace={(nextStore) => {
            storeRef.current = nextStore;
            setStore(nextStore);
          }}
        />
      )}
    </main>
  );
}

function PortalLoginGate({
  portal,
  portalPath,
  authConfig,
}: {
  portal: Portal;
  portalPath: string;
  authConfig: AuthConfig;
}) {
  const meta = portalMeta[portal];
  const Icon = meta.icon;
  return (
    <section className="workspace">
      <div className="panel empty-state">
        <Icon size={42} />
        <h1>{meta.title}</h1>
        <p>{meta.loginText}</p>
        {authConfig.configured ? (
          <a
            className="primary link-button"
            href={`/api/auth/wechat/start?redirect=${encodeURIComponent(portalPath)}`}
          >
            <MessageCircle size={18} />
            微信授权登录
          </a>
        ) : (
          <div className="auth-warning">
            <strong>微信授权未配置</strong>
            <small>{authConfig.missing.join("、") || "请检查服务端 OAuth 环境变量"}</small>
          </div>
        )}
      </div>
    </section>
  );
}

function AccessDenied() {
  return (
    <section className="workspace">
      <div className="panel empty-state">
        <ShieldCheck size={42} />
        <h1>无管理员权限</h1>
        <p>当前微信账号没有管理员权限。请使用已绑定管理员 openid 的微信账号访问。</p>
      </div>
    </section>
  );
}

function Header({
  portal,
  portalPath,
  currentUser,
  dataMode,
  authConfig,
  onRegister,
  onLogin,
  onLogout,
}: {
  portal: Portal;
  portalPath: string;
  currentUser?: User;
  dataMode: "loading" | "api" | "local";
  authConfig: AuthConfig;
  onRegister: (name: string, phone: string) => void;
  onLogin: (phone: string) => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loginPhone, setLoginPhone] = useState("");

  return (
    <header className="topbar">
      <div>
        <div className="brand">
          <MessageCircle size={24} />
          <span>{portalMeta[portal].title}</span>
        </div>
        <p>{portalMeta[portal].description}</p>
      </div>
      <div className="login-cluster">
        <span className={`data-badge ${dataMode}`}>
          {dataMode === "api"
            ? "服务端共享数据"
            : dataMode === "loading"
              ? "正在连接数据"
              : "本地备用数据"}
        </span>
        <div className="current-account">
          {currentUser?.avatarUrl ? (
            <img src={currentUser.avatarUrl} alt="" />
          ) : (
            <Avatar label={currentUser?.name ?? "微"} color={currentUser?.avatarColor ?? "#0f766e"} />
          )}
          <span>当前微信账号</span>
          <strong>{currentUser ? currentUser.nickname || currentUser.name : "未登录"}</strong>
          {currentUser?.isAdmin && <em>管理员</em>}
          {currentUser && (
            <button className="ghost small" onClick={onLogout}>
              退出
            </button>
          )}
        </div>
        {!currentUser && authConfig.configured && (
          <a
            className="primary link-button"
            href={`/api/auth/wechat/start?redirect=${encodeURIComponent(portalPath)}`}
          >
            <MessageCircle size={18} />
            微信授权登录
          </a>
        )}
        {!currentUser && !authConfig.configured && (
          <div className="auth-warning">
            <strong>微信授权未配置</strong>
            <small>{authConfig.missing.join("、") || "请检查服务端 OAuth 环境变量"}</small>
          </div>
        )}
        {authConfig.allowDevLogin && (
          <>
            <div className="register-line">
              <input
                value={loginPhone}
                onChange={(event) => setLoginPhone(event.target.value)}
                placeholder="测试 openid 登录"
              />
              <button
                className="ghost"
                disabled={!loginPhone.trim()}
                onClick={() => {
                  onLogin(loginPhone.trim());
                  setLoginPhone("");
                }}
              >
                开发登录
              </button>
            </div>
            <div className="register-line">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="微信昵称" />
              <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="测试 openid" />
              <button
                className="ghost"
                disabled={!name.trim() || !phone.trim()}
                onClick={() => {
                  onRegister(name.trim(), phone.trim());
                  setName("");
                  setPhone("");
                }}
              >
                开发注册
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function UserDesk({
  coaches,
  allCoaches,
  bookings,
  reviews,
  users,
  currentUser,
  selectedCoach,
  bookingError,
  query,
  onQuery,
  onSelectCoach,
  onBook,
  onPay,
  onNote,
  onReview,
}: {
  coaches: Coach[];
  allCoaches: Coach[];
  bookings: Booking[];
  reviews: Review[];
  users: User[];
  currentUser: User;
  selectedCoach?: Coach;
  bookingError: string;
  query: string;
  onQuery: (value: string) => void;
  onSelectCoach: (id: string) => void;
  onBook: (coach: Coach, slot: Slot) => void;
  onPay: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onReview: (bookingId: string, rating: number, content: string) => void;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [confirmSlot, setConfirmSlot] = useState<{ coach: Coach; slot: Slot } | null>(null);
  const userBookings = bookings.filter((booking) => booking.userId === currentUser.id);
  const coachReviews = selectedCoach
    ? reviews.filter((review) => review.coachId === selectedCoach.id)
    : [];
  const handleSelectCoach = (coachId: string) => {
    onSelectCoach(coachId);
    window.setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  return (
    <section className="workspace two-col">
      <div className="panel coach-list">
        <div className="section-title">
          <div>
            <h1>可预约教练</h1>
            <p>已通过审核并上架的教练会直接显示；点开教练即可查看详情和预约时间。</p>
          </div>
        </div>
        <div className="searchbox">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索教练、特长或背景"
          />
        </div>
        <div className="coach-stack">
          {coaches.length === 0 && (
            <div className="inline-empty">
              <Users size={30} />
              <strong>暂无已上架教练</strong>
              <small>管理员审核通过并上架教练后，用户登录即可在这里直接看到。</small>
            </div>
          )}
          {coaches.map((coach) => {
            const average =
              reviews.filter((review) => review.coachId === coach.id).reduce((sum, item) => sum + item.rating, 0) /
              Math.max(1, reviews.filter((review) => review.coachId === coach.id).length);
            return (
              <button
                className={`coach-card ${selectedCoach?.id === coach.id ? "selected" : ""}`}
                key={coach.id}
                onClick={() => handleSelectCoach(coach.id)}
              >
                <Avatar label={coach.name} color={avatarForCoach(coach)} />
                <span>
                  <strong>{coach.name}</strong>
                  <small>{coach.title}</small>
                  <em>
                    <Star size={14} fill="currentColor" />
                    {average.toFixed(1)} · {formatMoney(coach.price)}/次
                  </em>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="detail-stack">
        {selectedCoach && (
          <div className="panel detail-panel" ref={detailRef}>
            <div className="coach-hero">
              <Avatar label={selectedCoach.name} color={avatarForCoach(selectedCoach)} large />
              <div>
                <h2>{selectedCoach.name}</h2>
                <p>{selectedCoach.title}</p>
                <div className="tag-row">
                  {selectedCoach.specialties.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
              <strong>{formatMoney(selectedCoach.price)}</strong>
            </div>
            <div className="info-grid">
              <article>
                <h3>介绍</h3>
                <p>{selectedCoach.intro}</p>
              </article>
              <article>
                <h3>背景</h3>
                <p>{selectedCoach.background}</p>
              </article>
            </div>
            <h3 className="subhead">可预约时间</h3>
            <div className="slot-grid">
              {selectedCoach.slots
                .filter((slot) => slot.enabled)
                .map((slot) => {
                  const isOwnCoach = selectedCoach.userId === currentUser.id;
                  const occupied = bookings.some(
                    (booking) =>
                      booking.coachId === selectedCoach.id &&
                      booking.slotId === slot.id &&
                      booking.status !== "declined",
                  );
                  return (
                    <button
                      key={slot.id}
                      className="slot-card"
                      disabled={occupied || isOwnCoach}
                      onClick={() => setConfirmSlot({ coach: selectedCoach, slot })}
                    >
                      <CalendarDays size={18} />
                      <span>{slot.weekday}</span>
                      <strong>{slot.date}</strong>
                      <small>{slot.time}</small>
                      <em>{isOwnCoach ? "不能预约自己" : occupied ? "已预约" : "预约并支付"}</em>
                    </button>
                  );
                })}
              {selectedCoach.slots.filter((slot) => slot.enabled).length === 0 && (
                <p className="muted">该教练暂未开放可预约时间</p>
              )}
            </div>
            <h3 className="subhead">用户评价</h3>
            <ReviewList reviews={coachReviews} users={users} empty="还没有评价" />
          </div>
        )}
        {!selectedCoach && (
          <div className="panel empty-state compact-empty">
            <CalendarDays size={42} />
            <h2>等待教练开放</h2>
            <p>有教练通过审核并开放可预约时间后，这里会显示详情和预约入口。</p>
          </div>
        )}

        <div className="panel">
          <div className="section-title compact">
            <div>
              <h2>我的待办</h2>
              <p>支付后生成待办，教练接受并确认完成后，你再评价。</p>
            </div>
          </div>
          <BookingList
            bookings={userBookings}
            coaches={allCoaches}
            currentUser={currentUser}
            onPay={onPay}
            onNote={onNote}
            onReview={onReview}
          />
          {bookingError && <p className="error-text">{bookingError}</p>}
        </div>
      </div>
      {confirmSlot && (
        <ConfirmBookingModal
          coach={confirmSlot.coach}
          slot={confirmSlot.slot}
          onClose={() => setConfirmSlot(null)}
          onConfirm={() => {
            onBook(confirmSlot.coach, confirmSlot.slot);
            setConfirmSlot(null);
          }}
        />
      )}
    </section>
  );
}

function CoachDesk({
  coach,
  currentUser,
  bookings,
  reviews,
  users,
  withdrawals,
  onApply,
  onUpdateCoach,
  onAddSlot,
  onUpdateSlot,
  onRemoveSlot,
  onWithdraw,
  onBookingStatus,
}: {
  coach?: Coach;
  currentUser: User;
  bookings: Booking[];
  reviews: Review[];
  users: User[];
  withdrawals: Withdrawal[];
  onApply: (
    application: Pick<Coach, "name" | "title" | "price" | "intro" | "background" | "specialties" | "slots">,
    status?: CoachStatus,
  ) => void;
  onUpdateCoach: (coachId: string, patch: Partial<Coach>) => void;
  onAddSlot: (coachId: string) => void;
  onUpdateSlot: (coachId: string, slotId: string, patch: Partial<Slot>) => void;
  onRemoveSlot: (coachId: string, slotId: string) => void;
  onWithdraw: (coachId: string, amount: number) => void;
  onBookingStatus: (id: string, status: BookingStatus) => void;
}) {
  if (!coach) {
    return (
      <section className="workspace">
        <CoachApplicationForm currentUser={currentUser} onSubmit={onApply} />
      </section>
    );
  }

  const coachBookings = bookings.filter((booking) => booking.coachId === coach.id);
  const completedIncome = coachBookings
    .filter((booking) => booking.status === "completed" || booking.status === "reviewed")
    .reduce((sum, booking) => sum + booking.coachIncome, 0);
  const paidOut = withdrawals
    .filter(
      (withdrawal) =>
        (withdrawal.target ?? "coach") === "coach" &&
        withdrawal.coachId === coach.id &&
        withdrawal.status !== "rejected",
    )
    .reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const withdrawable = Math.max(0, completedIncome - paidOut);
  const listingStatus = getCoachListingStatus(coach);
  const coachReviews = reviews.filter((review) => review.coachId === coach.id);
  const isApproved = coach.status === "approved";

  return (
    <section className="workspace two-col">
      <div className="panel">
        <div className="section-title">
          <div>
            <h1>教练中心</h1>
            <p>
              {isApproved
                ? "你可以维护资料、排期、处理订单、查看评价并申请提现。"
                : "审核通过前只开放资料维护；被拒绝后可修改资料并重新提交。"}
            </p>
          </div>
          <div className="status-stack">
            <span className={`pill ${coach.status}`}>{coachStatusText[coach.status]}</span>
            <span className={`pill ${listingStatus}`}>{coachListingStatusText[listingStatus]}</span>
          </div>
        </div>
        {!isApproved && (
          <div className="notice-box">
            <strong>{coach.status === "pending" ? "申请正在等待管理员审核" : "申请已被拒绝"}</strong>
            <p>
              {coach.status === "pending"
                ? "你可以继续修改展示资料和可预约时间，管理员审核通过并上架后才会出现在用户端。"
                : "请根据沟通结果修改资料，再重新提交审核。重新提交后状态会回到待审核。"}
            </p>
            {coach.status === "rejected" && (
              <button
                className="primary"
                onClick={() => onUpdateCoach(coach.id, { status: "pending", listingStatus: "unlisted" })}
              >
                <Check size={17} />
                重新提交审核
              </button>
            )}
          </div>
        )}
        {isApproved && listingStatus === "unlisted" && (
          <div className="notice-box">
            <strong>当前未上架</strong>
            <p>用户端不会展示你的主页，也不能产生新预约；历史订单和评价仍然保留。</p>
          </div>
        )}
        <EditableCoach coach={coach} onUpdate={onUpdateCoach} disabled={false} />
      </div>

      {isApproved && (
        <div className="detail-stack">
        <div className="panel">
          <div className="metric-row">
            <Metric icon={<CreditCard size={19} />} label="待确认订单" value={coachBookings.filter((b) => b.status === "paid").length.toString()} />
            <Metric icon={<WalletCards size={19} />} label="可提现" value={formatMoney(withdrawable)} />
            <Metric icon={<Star size={19} />} label="评价数" value={reviews.filter((review) => review.coachId === coach.id).length.toString()} />
          </div>
          <button
            className="primary full"
            disabled={coach.status !== "approved" || withdrawable <= 0}
            onClick={() => onWithdraw(coach.id, withdrawable)}
          >
            <HandCoins size={18} />
            申请提现 {formatMoney(withdrawable)}
          </button>
        </div>

        <div className="panel">
          <div className="section-title compact">
            <div>
              <h2>可预约时间</h2>
              <p>当前 MVP 限定周三或周四下午，由教练自己维护。</p>
            </div>
            <button className="ghost" onClick={() => onAddSlot(coach.id)}>
              <Plus size={17} />
              添加
            </button>
          </div>
          <SlotEditor coach={coach} onUpdate={onUpdateSlot} onRemove={onRemoveSlot} disabled={false} />
        </div>

        <div className="panel">
          <h2>教练待办与订单</h2>
          <CoachBookingTable bookings={coachBookings} coach={coach} users={users} onStatus={onBookingStatus} />
        </div>

        <div className="panel">
          <h2>用户评价</h2>
          <ReviewList reviews={coachReviews} users={users} empty="还没有用户评价" />
        </div>
      </div>
      )}
    </section>
  );
}

function AdminDesk({
  store,
  onUpdateCoach,
  onDeleteCoach,
  onSettings,
  onPlatformWithdraw,
  onConfirmPayment,
  onWithdrawal,
}: {
  store: Store;
  onUpdateCoach: (coachId: string, patch: Partial<Coach>) => void;
  onDeleteCoach: (coachId: string) => void;
  onSettings: (settings: Settings) => void;
  onPlatformWithdraw: (amount: number) => void;
  onConfirmPayment: (bookingId: string) => void;
  onWithdrawal: (id: string, status: WithdrawalStatus) => void;
}) {
  const gross = store.bookings
    .filter((booking) => booking.status !== "reserved")
    .reduce((sum, booking) => sum + booking.amount, 0);
  const escrow = store.bookings
    .filter((booking) => booking.status === "paid" || booking.status === "accepted")
    .reduce((sum, booking) => sum + booking.amount, 0);
  const platformFees = store.bookings
    .filter((booking) => booking.status === "completed" || booking.status === "reviewed")
    .reduce((sum, booking) => sum + booking.platformFee, 0);
  const platformPaidOut = store.withdrawals
    .filter((withdrawal) => withdrawal.target === "platform" && withdrawal.status !== "rejected")
    .reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const platformWithdrawable = Math.max(0, platformFees - platformPaidOut);

  return (
    <section className="workspace admin-grid">
      <div className="panel admin-span">
        <div className="section-title">
          <div>
            <h1>管理后台</h1>
            <p>管理员由后台绑定微信 openid，这里只模拟最高权限。</p>
          </div>
          <ShieldCheck size={28} />
        </div>
        <div className="metric-row">
          <Metric icon={<Users size={19} />} label="注册用户" value={store.users.length.toString()} />
          <Metric icon={<UserRoundCheck size={19} />} label="教练数" value={store.coaches.length.toString()} />
          <Metric icon={<ClipboardList size={19} />} label="订单数" value={store.bookings.length.toString()} />
          <Metric icon={<CreditCard size={19} />} label="成交金额" value={formatMoney(gross)} />
          <Metric icon={<WalletCards size={19} />} label="托管中" value={formatMoney(escrow)} />
          <Metric icon={<HandCoins size={19} />} label="平台收入" value={formatMoney(platformFees)} />
        </div>
        <a className="ghost link-button backup-link" href="/api/admin/export">
          <ClipboardList size={17} />
          导出数据备份
        </a>
      </div>

      <div className="panel">
        <h2>抽佣设置</h2>
        <div className="setting-line">
          <span>平台抽佣</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={store.settings.commissionEnabled}
              onChange={(event) =>
                onSettings({ ...store.settings, commissionEnabled: event.target.checked })
              }
            />
            <i />
          </label>
        </div>
        <label className="field">
          <span>抽佣比例</span>
          <input
            type="number"
            min="0"
            max="80"
            value={store.settings.commissionRate}
            onChange={(event) =>
              onSettings({ ...store.settings, commissionRate: Number(event.target.value) })
            }
          />
        </label>
        <button
          className="primary full"
          disabled={platformWithdrawable <= 0}
          onClick={() => onPlatformWithdraw(platformWithdrawable)}
        >
          <HandCoins size={18} />
          提取平台扣点 {formatMoney(platformWithdrawable)}
        </button>
      </div>

      <PaymentSetupPanel />

      <div className="panel">
        <h2>用户注册</h2>
        <div className="simple-list">
          {store.users.map((user) => (
            <div key={user.id}>
              <Avatar label={user.name} color={user.avatarColor} />
              <span>
                <strong>{user.name}</strong>
                <small>{user.phone}</small>
              </span>
              {user.isAdmin && <em>管理员</em>}
            </div>
          ))}
        </div>
      </div>

      <div className="panel admin-span">
        <h2>教练维护与审核</h2>
        <div className="admin-table">
          {store.coaches.map((coach) => {
            const listingStatus = getCoachListingStatus(coach);
            return (
              <div key={coach.id} className="admin-row coach-admin-row">
                <Avatar label={coach.name} color={avatarForCoach(coach)} />
                <span>
                  <strong>{coach.name}</strong>
                  <small>{coach.title}</small>
                </span>
                <div className="status-stack">
                  <span className={`pill ${coach.status}`}>{coachStatusText[coach.status]}</span>
                  <span className={`pill ${listingStatus}`}>{coachListingStatusText[listingStatus]}</span>
                </div>
                <label>
                  <span>价格</span>
                  <input
                    type="number"
                    value={coach.price}
                    onChange={(event) => onUpdateCoach(coach.id, { price: Number(event.target.value) })}
                  />
                </label>
                <div className="review-actions" aria-label={`${coach.name}审核操作`}>
                  <button
                    className="primary small"
                    disabled={coach.status === "approved"}
                    onClick={() => onUpdateCoach(coach.id, { status: "approved", listingStatus: "unlisted" })}
                  >
                    <Check size={16} />
                    通过审核
                  </button>
                  <button
                    className="ghost danger-text small"
                    disabled={coach.status === "rejected"}
                    onClick={() => onUpdateCoach(coach.id, { status: "rejected", listingStatus: "unlisted" })}
                  >
                    <X size={16} />
                    拒绝
                  </button>
                  <button
                    className="ghost small"
                    disabled={coach.status !== "approved"}
                    onClick={() =>
                      onUpdateCoach(coach.id, {
                        listingStatus: listingStatus === "listed" ? "unlisted" : "listed",
                      })
                    }
                  >
                    {listingStatus === "listed" ? "下架" : "上架"}
                  </button>
                </div>
                <button className="icon-danger" onClick={() => onDeleteCoach(coach.id)} aria-label="删除教练">
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel admin-span">
        <h2>订单收款与流转</h2>
        <AdminBookingTable
          bookings={store.bookings}
          coaches={store.coaches}
          users={store.users}
          onConfirmPayment={onConfirmPayment}
        />
      </div>

      <div className="panel admin-span">
        <h2>提现审核</h2>
        <div className="admin-table">
          {store.withdrawals.length === 0 && <p className="muted">暂无提现申请</p>}
          {store.withdrawals.map((withdrawal) => {
            const isPlatform = withdrawal.target === "platform";
            const coach = store.coaches.find((item) => item.id === withdrawal.coachId);
            return (
              <div key={withdrawal.id} className="admin-row">
                <HandCoins size={22} />
                <span>
                  <strong>{isPlatform ? "平台扣点" : coach?.name ?? "未知教练"}</strong>
                  <small>{withdrawal.createdAt}</small>
                </span>
                <strong>{formatMoney(withdrawal.amount)}</strong>
                <span className={`pill ${withdrawal.status}`}>{withdrawal.status}</span>
                <button className="ghost" onClick={() => onWithdrawal(withdrawal.id, "approved")}>
                  <Check size={16} />
                  通过
                </button>
                <button className="ghost danger-text" onClick={() => onWithdrawal(withdrawal.id, "rejected")}>
                  <X size={16} />
                  拒绝
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PaymentSetupPanel() {
  const [config, setConfig] = useState<PaymentConfig | null>(null);

  useEffect(() => {
    fetch("/api/payment-config")
      .then((response) => response.json() as Promise<PaymentConfig>)
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  return (
    <div className="panel payment-setup-panel">
      <div className="section-title compact">
        <div>
          <h2>微信支付配置</h2>
          <p>先用人工收款确认试运营；商户资料补齐后，这里会自动切换为扫码支付。</p>
        </div>
        <CreditCard size={24} />
      </div>
      {!config && <p className="muted">正在读取支付配置...</p>}
      {config && (
        <>
          <span className={`pill ${config.configured ? "approved" : "pending"}`}>
            {config.configured ? "微信支付已配置" : "微信支付未配置"}
          </span>
          {!config.configured && (
            <div className="payment-setup-steps">
              <a
                className="primary link-button full"
                href={config.merchantPortalUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={17} />
                登录微信支付商户平台
              </a>
              <ol>
                <li>用商户管理员微信扫码登录，确认商户号、绑定的公众号 AppID，并开通 Native 支付。</li>
                <li>进入“账户中心 / API 安全”，设置 API v3 密钥，下载商户 API 证书并复制私钥内容。</li>
                <li>获取商户 API 证书序列号，并下载或复制微信支付平台公钥。</li>
                <li>到 Render 的 Environment 页面填入下方环境变量，然后重新部署服务。</li>
              </ol>
              <label className="field full-field">
                <span>支付回调地址</span>
                <input readOnly value={config.suggestedNotifyUrl} />
              </label>
              <div className="env-list">
                {config.requiredEnv.map((item) => (
                  <code key={item} className={config.missing.some((missing) => missing.includes(item)) ? "missing-env" : ""}>
                    {item}
                  </code>
                ))}
              </div>
              <small className="muted">
                当前缺少：{config.missing.length ? config.missing.join("、") : "无"}
              </small>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CoachApplicationForm({
  currentUser,
  onSubmit,
}: {
  currentUser: User;
  onSubmit: (
    application: Pick<Coach, "name" | "title" | "price" | "intro" | "background" | "specialties" | "slots">,
    status?: CoachStatus,
  ) => void;
}) {
  const [draft, setDraft] = useState<
    Pick<Coach, "name" | "title" | "price" | "intro" | "background" | "specialties" | "slots">
  >({
    name: currentUser.nickname || currentUser.name,
    title: "",
    price: 399,
    intro: "",
    background: "",
    specialties: [],
    slots: [
      {
        id: makeId("s"),
        weekday: "周三",
        date: "2026-05-27",
        time: "14:00-15:00",
        enabled: true,
      },
    ],
  });
  const specialtyText = draft.specialties.join("，");
  const canSubmit =
    draft.name.trim() &&
    draft.title.trim() &&
    draft.intro.trim() &&
    draft.background.trim() &&
    draft.price > 0 &&
    draft.slots.some((slot) => slot.enabled && slot.date && slot.time.trim());

  const updateSlotDraft = (slotId: string, patch: Partial<Slot>) => {
    setDraft({
      ...draft,
      slots: draft.slots.map((slot) => (slot.id === slotId ? { ...slot, ...patch } : slot)),
    });
  };

  return (
    <div className="panel application-panel">
      <div className="section-title">
        <div>
          <h1>申请成为教练</h1>
          <p>先完善展示资料、价格和可预约时间，再提交给管理员审核。</p>
        </div>
        <UserRoundCheck size={32} />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>展示名称</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="用户看到的教练名称"
          />
        </label>
        <label className="field">
          <span>单次价格</span>
          <input
            type="number"
            min="1"
            value={draft.price}
            onChange={(event) => setDraft({ ...draft, price: Number(event.target.value) })}
          />
        </label>
        <label className="field full-field">
          <span>标题</span>
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="例如：职业转型与管理沟通教练"
          />
        </label>
        <label className="field full-field">
          <span>教练介绍</span>
          <textarea
            value={draft.intro}
            onChange={(event) => setDraft({ ...draft, intro: event.target.value })}
            placeholder="说明你适合帮助什么样的用户、解决什么问题"
          />
        </label>
        <label className="field full-field">
          <span>背景介绍</span>
          <textarea
            value={draft.background}
            onChange={(event) => setDraft({ ...draft, background: event.target.value })}
            placeholder="说明你的工作经历、项目经验、资质或代表成果"
          />
        </label>
        <label className="field full-field">
          <span>特长，用逗号分隔</span>
          <input
            value={specialtyText}
            onChange={(event) =>
              setDraft({
                ...draft,
                specialties: event.target.value
                  .split(/[，,]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="职业规划，面试辅导，管理沟通"
          />
        </label>
      </div>

      <div className="section-title compact application-slots-title">
        <div>
          <h2>可预约时间</h2>
          <p>至少开放一个周三或周四下午的对话时间。</p>
        </div>
        <button
          className="ghost"
          onClick={() =>
            setDraft({
              ...draft,
              slots: [
                ...draft.slots,
                {
                  id: makeId("s"),
                  weekday: "周三",
                  date: "2026-05-27",
                  time: "14:00-15:00",
                  enabled: true,
                },
              ],
            })
          }
        >
          <Plus size={17} />
          添加时间
        </button>
      </div>
      <div className="slot-editor">
        {draft.slots.map((slot) => (
          <div key={slot.id} className="slot-edit-row">
            <select
              value={slot.weekday}
              onChange={(event) => updateSlotDraft(slot.id, { weekday: event.target.value as Slot["weekday"] })}
            >
              <option value="周三">周三</option>
              <option value="周四">周四</option>
            </select>
            <input
              type="date"
              value={slot.date}
              onChange={(event) => updateSlotDraft(slot.id, { date: event.target.value })}
            />
            <input
              value={slot.time}
              onChange={(event) => updateSlotDraft(slot.id, { time: event.target.value })}
              placeholder="14:00-15:00"
            />
            <label className="mini-check">
              <input
                type="checkbox"
                checked={slot.enabled}
                onChange={(event) => updateSlotDraft(slot.id, { enabled: event.target.checked })}
              />
              开放
            </label>
            <button
              className="icon-danger"
              disabled={draft.slots.length <= 1}
              onClick={() => setDraft({ ...draft, slots: draft.slots.filter((item) => item.id !== slot.id) })}
              aria-label="删除时间"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="primary full application-submit"
        disabled={!canSubmit}
        onClick={() =>
          onSubmit({
            ...draft,
            name: draft.name.trim(),
            title: draft.title.trim(),
            intro: draft.intro.trim(),
            background: draft.background.trim(),
            specialties: draft.specialties.length ? draft.specialties : ["综合教练"],
            slots: draft.slots.map((slot) => ({ ...slot, time: slot.time.trim() })),
          })
        }
      >
        <Plus size={18} />
        提交教练申请
      </button>
    </div>
  );
}

function EditableCoach({
  coach,
  onUpdate,
  disabled,
}: {
  coach: Coach;
  onUpdate: (coachId: string, patch: Partial<Coach>) => void;
  disabled: boolean;
}) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>展示名称</span>
        <input value={coach.name} disabled={disabled} onChange={(event) => onUpdate(coach.id, { name: event.target.value })} />
      </label>
      <label className="field">
        <span>单次价格</span>
        <input type="number" value={coach.price} disabled={disabled} onChange={(event) => onUpdate(coach.id, { price: Number(event.target.value) })} />
      </label>
      <label className="field full-field">
        <span>标题</span>
        <input value={coach.title} disabled={disabled} onChange={(event) => onUpdate(coach.id, { title: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>教练介绍</span>
        <textarea value={coach.intro} disabled={disabled} onChange={(event) => onUpdate(coach.id, { intro: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>背景介绍</span>
        <textarea value={coach.background} disabled={disabled} onChange={(event) => onUpdate(coach.id, { background: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>特长，用逗号分隔</span>
        <input
          value={coach.specialties.join("，")}
          disabled={disabled}
          onChange={(event) =>
            onUpdate(coach.id, {
              specialties: event.target.value
                .split(/[，,]/)
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
    </div>
  );
}

function SlotEditor({
  coach,
  onUpdate,
  onRemove,
  disabled,
}: {
  coach: Coach;
  onUpdate: (coachId: string, slotId: string, patch: Partial<Slot>) => void;
  onRemove: (coachId: string, slotId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="slot-editor">
      {coach.slots.length === 0 && <p className="muted">还没有设置可预约时间</p>}
      {coach.slots.map((slot) => (
        <div key={slot.id} className="slot-edit-row">
          <select
            value={slot.weekday}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { weekday: event.target.value as Slot["weekday"] })}
          >
            <option value="周三">周三</option>
            <option value="周四">周四</option>
          </select>
          <input
            type="date"
            value={slot.date}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { date: event.target.value })}
          />
          <input
            value={slot.time}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { time: event.target.value })}
          />
          <label className="mini-check">
            <input
              type="checkbox"
              checked={slot.enabled}
              disabled={disabled}
              onChange={(event) => onUpdate(coach.id, slot.id, { enabled: event.target.checked })}
            />
            开放
          </label>
          <button disabled={disabled} className="icon-danger" onClick={() => onRemove(coach.id, slot.id)} aria-label="删除时间">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function BookingList({
  bookings,
  coaches,
  currentUser,
  onPay,
  onNote,
  onReview,
}: {
  bookings: Booking[];
  coaches: Coach[];
  currentUser: User;
  onPay: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onReview: (bookingId: string, rating: number, content: string) => void;
}) {
  const [reviewDraft, setReviewDraft] = useState<Record<string, string>>({});
  const [ratingDraft, setRatingDraft] = useState<Record<string, number>>({});
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  if (bookings.length === 0) {
    return <p className="muted">暂无预约</p>;
  }

  return (
    <div className="booking-stack">
      {bookings.map((booking) => {
        const coach = coaches.find((item) => item.id === booking.coachId);
        const slot = getSlot(coach, booking.slotId);
        const rating = ratingDraft[booking.id] ?? 5;
        const content = reviewDraft[booking.id] ?? "";
        const note = noteDraft[booking.id] ?? booking.note ?? "";
        return (
          <article key={booking.id} className="booking-card">
            <div>
              <strong>{coach?.name}</strong>
              <span>{slot ? `${slot.weekday} ${slot.date} ${slot.time}` : "时间已删除"}</span>
              <small>
                {statusText[booking.status]} · 托管金额 {formatMoney(booking.amount)}
              </small>
              {booking.status === "payment_pending" && (
                <em className="todo-label">待办：平台确认收款后，教练会收到确认提醒</em>
              )}
              {booking.status === "paid" && <em className="todo-label">待办：等待教练接受</em>}
              {booking.status === "accepted" && <em className="todo-label">待办：按约定时间完成对话</em>}
              {booking.status === "declined" && <em className="todo-label rejected">教练未接受，请联系平台处理退款或重约</em>}
            </div>
            <div className="booking-actions">
              {booking.status === "reserved" && (
                <button className="primary small" onClick={() => onPay(booking.id)}>
                  <QrCode size={16} />
                  去支付
                </button>
              )}
            </div>
            {(booking.status === "paid" || booking.status === "accepted") && (
              <div className="note-box">
                <textarea
                  value={note}
                  onChange={(event) => setNoteDraft({ ...noteDraft, [booking.id]: event.target.value })}
                  placeholder="给教练捎句话：你的问题、背景、希望重点聊什么"
                />
                <button className="ghost small" onClick={() => onNote(booking.id, note.trim())}>
                  <MessageSquareText size={16} />
                  保存留言
                </button>
              </div>
            )}
            {booking.status === "completed" && (
              <div className="review-box">
                <select value={rating} onChange={(event) => setRatingDraft({ ...ratingDraft, [booking.id]: Number(event.target.value) })}>
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={value}>
                      {value} 星
                    </option>
                  ))}
                </select>
                <input
                  value={content}
                  onChange={(event) => setReviewDraft({ ...reviewDraft, [booking.id]: event.target.value })}
                  placeholder={`${currentUser.name}，写下这次对话的反馈`}
                />
                <button className="primary small" disabled={!content.trim()} onClick={() => onReview(booking.id, rating, content.trim())}>
                  <MessageSquareText size={16} />
                  提交评价
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function CoachBookingTable({
  bookings,
  coach,
  users,
  onStatus,
}: {
  bookings: Booking[];
  coach: Coach;
  users: User[];
  onStatus: (id: string, status: BookingStatus) => void;
}) {
  if (bookings.length === 0) return <p className="muted">暂无预约订单</p>;
  const statusPriority: Record<BookingStatus, number> = {
    paid: 0,
    accepted: 1,
    completed: 2,
    payment_pending: 3,
    reserved: 4,
    reviewed: 5,
    declined: 6,
  };
  const sortedBookings = [...bookings].sort(
    (left, right) => statusPriority[left.status] - statusPriority[right.status],
  );
  return (
    <div className="order-table">
      {sortedBookings.map((booking) => {
        const slot = getSlot(coach, booking.slotId);
        const user = users.find((item) => item.id === booking.userId);
        return (
          <div key={booking.id}>
            <span>
              <strong>{user?.name ?? "未知用户"}</strong>
              {booking.status === "paid" && <small className="new-order">新预约待接受</small>}
              {booking.status === "accepted" && <small className="new-order">已接受，待完成</small>}
              {booking.note && <small>留言：{booking.note}</small>}
            </span>
            <small>{slot ? `${slot.date} ${slot.time}` : "时间已删除"}</small>
            <strong>{formatMoney(booking.coachIncome)}</strong>
            <em>{statusText[booking.status]}</em>
            <div className="order-actions">
              {booking.status === "paid" && (
                <>
                  <button className="primary small" onClick={() => onStatus(booking.id, "accepted")}>
                    <Check size={16} />
                    接受
                  </button>
                  <button className="ghost danger-text small" onClick={() => onStatus(booking.id, "declined")}>
                    <X size={16} />
                    不接受
                  </button>
                </>
              )}
              {booking.status === "accepted" && (
                <button className="primary small" onClick={() => onStatus(booking.id, "completed")}>
                  <Check size={16} />
                  确认完成
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AdminBookingTable({
  bookings,
  coaches,
  users,
  onConfirmPayment,
}: {
  bookings: Booking[];
  coaches: Coach[];
  users: User[];
  onConfirmPayment: (bookingId: string) => void;
}) {
  if (bookings.length === 0) return <p className="muted">暂无订单</p>;
  const statusPriority: Record<BookingStatus, number> = {
    payment_pending: 0,
    reserved: 1,
    paid: 2,
    accepted: 3,
    completed: 4,
    reviewed: 5,
    declined: 6,
  };
  const sortedBookings = [...bookings].sort(
    (left, right) => statusPriority[left.status] - statusPriority[right.status],
  );

  return (
    <div className="admin-order-table">
      {sortedBookings.map((booking) => {
        const coach = coaches.find((item) => item.id === booking.coachId);
        const user = users.find((item) => item.id === booking.userId);
        const slot = getSlot(coach, booking.slotId);
        const canConfirmPayment =
          booking.status === "payment_pending" ||
          (booking.status === "reserved" && booking.payment?.provider === "manual_confirmation");
        return (
          <div key={booking.id} className="admin-row admin-order-row">
            <CreditCard size={22} />
            <span>
              <strong>
                {user?.name ?? "未知用户"} 预约 {coach?.name ?? "未知教练"}
              </strong>
              <small>
                {slot ? `${slot.date} ${slot.time}` : "时间已删除"} · {booking.createdAt}
              </small>
            </span>
            <strong>{formatMoney(booking.amount)}</strong>
            <span className={`pill ${booking.status}`}>{statusText[booking.status]}</span>
            <button
              className="primary small"
              disabled={!canConfirmPayment}
              onClick={() => onConfirmPayment(booking.id)}
            >
              <Check size={16} />
              确认收款
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ReviewList({ reviews, users, empty }: { reviews: Review[]; users: User[]; empty: string }) {
  if (reviews.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="review-list">
      {reviews.map((review) => {
        const user = users.find((item) => item.id === review.userId);
        return (
          <article key={review.id}>
            <div>
              <strong>{user?.name ?? "匿名用户"}</strong>
              <span>
                {Array.from({ length: review.rating }).map((_, index) => (
                  <Star key={index} size={14} fill="currentColor" />
                ))}
              </span>
            </div>
            <p>{review.content}</p>
            <small>{review.createdAt}</small>
          </article>
        );
      })}
    </div>
  );
}

function ConfirmBookingModal({
  coach,
  slot,
  onClose,
  onConfirm,
}: {
  coach: Coach;
  slot: Slot;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="close" onClick={onClose} aria-label="关闭">
          <X size={18} />
        </button>
        <CalendarDays size={46} className="modal-icon" />
        <h2>确认预约</h2>
        <div className="confirm-summary">
          <span>教练</span>
          <strong>{coach.name}</strong>
          <span>时间</span>
          <strong>
            {slot.weekday} {slot.date} {slot.time}
          </strong>
          <span>金额</span>
          <strong>{formatMoney(coach.price)}</strong>
        </div>
        <p className="muted">确认后进入支付确认。收款确认后会生成待办，并通知教练确认是否接受。</p>
        <button className="primary full" onClick={onConfirm}>
          <QrCode size={18} />
          确认并进入支付
        </button>
      </div>
    </div>
  );
}

function PaymentModal({
  booking,
  coach,
  onClose,
  onPay,
  onStoreReplace,
}: {
  booking?: Booking;
  coach?: Coach;
  onClose: () => void;
  onPay: () => void;
  onStoreReplace: (store: Store) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [codeUrl, setCodeUrl] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [allowMock, setAllowMock] = useState(false);
  const [error, setError] = useState("");
  const [manualRequested, setManualRequested] = useState(false);

  useEffect(() => {
    if (!booking) return;
    let stopped = false;
    setLoading(true);
    setError("");
    setMissing([]);
    setQrDataUrl("");
    setCodeUrl("");
    setManualRequested(false);

    fetch("/api/payment-config")
      .then((response) => response.json())
      .then((config) => {
        if (stopped) return;
        setAllowMock(Boolean(config.allowMock));
        if (!config.configured) {
          setMissing(config.missing ?? []);
          return null;
        }
        return fetch("/api/payments/wechat/native", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId: booking.id }),
        });
      })
      .then((response) => {
        if (!response || stopped) return null;
        if (!response.ok) {
          return response.json().then((body) => {
            throw new Error(body.message || body.error || "微信支付下单失败");
          });
        }
        return response.json();
      })
      .then((payment) => {
        if (!payment || stopped) return;
        setQrDataUrl(payment.qrDataUrl);
        setCodeUrl(payment.codeUrl);
      })
      .catch((err) => {
        if (!stopped) setError(err.message || "微信支付下单失败");
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });

    const poll = window.setInterval(() => {
      fetch("/api/store")
        .then((response) => response.json())
        .then((remoteStore: Store) => {
          if (stopped) return;
          const remoteBooking = remoteStore.bookings.find((item) => item.id === booking.id);
          if (remoteBooking?.status === "paid") {
            onStoreReplace(remoteStore);
            onClose();
          }
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      stopped = true;
      window.clearInterval(poll);
    };
  }, [booking?.id]);

  if (!booking || !coach) return null;
  const slot = getSlot(coach, booking.slotId);

  async function mockPay() {
    setLoading(true);
    setError("");
    const response = await fetch("/api/payments/mock-success", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: booking?.id }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || "测试支付未启用");
      setLoading(false);
      return;
    }
    onPay();
    setLoading(false);
  }

  async function requestManualConfirmation() {
    setLoading(true);
    setError("");
    const response = await fetch("/api/payments/manual-confirmation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: booking?.id }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || "提交人工确认失败");
      setLoading(false);
      return;
    }
    const payload = (await response.json()) as { store: Store };
    onStoreReplace(payload.store);
    setManualRequested(true);
    setLoading(false);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="close" onClick={onClose} aria-label="关闭">
          <X size={18} />
        </button>
        <div className="qr-visual">
          {qrDataUrl ? <img src={qrDataUrl} alt="微信支付二维码" /> : <QrCode size={112} />}
        </div>
        <h2>支付确认</h2>
        <p>
          {coach.name} · {slot?.date} {slot?.time}
        </p>
        <strong>{formatMoney(booking.amount)}</strong>
        {loading && <p className="muted">正在创建微信支付订单...</p>}
        {qrDataUrl && (
          <p className="muted">请使用微信扫码支付。支付成功回调后，订单会自动进入平台托管。</p>
        )}
        {codeUrl && <textarea className="code-url" readOnly value={codeUrl} />}
        {missing.length > 0 && (
          <div className="payment-warning">
            <strong>微信支付尚未配置</strong>
            <p>当前可先走人工收款确认；补齐微信支付环境变量后，会自动显示扫码支付。</p>
            <small>{missing.join("、")}</small>
          </div>
        )}
        {manualRequested && (
          <div className="payment-success">
            <strong>已提交平台确认</strong>
            <p>管理员确认收款后，订单会进入“待教练确认”。</p>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        {missing.length > 0 && !manualRequested && (
          <button className="primary full" onClick={requestManualConfirmation} disabled={loading}>
            <HandCoins size={18} />
            已付款，提交平台确认
          </button>
        )}
        {allowMock && (
          <button className="ghost full" onClick={mockPay} disabled={loading}>
            <BadgeCheck size={18} />
            测试环境标记支付成功
          </button>
        )}
      </div>
    </div>
  );
}

function Avatar({ label, color, large = false }: { label: string; color: string; large?: boolean }) {
  return (
    <div className={`avatar ${large ? "large" : ""}`} style={{ background: color }}>
      {label.slice(0, 1)}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function avatarForCoach(coach: Coach) {
  const colors = ["#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c"];
  return colors[coach.id.charCodeAt(coach.id.length - 1) % colors.length];
}
