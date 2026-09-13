"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AiOutlineLoading3Quarters } from "react-icons/ai";
import { MdArrowBack } from "react-icons/md";
import { SiStellar } from "react-icons/si";

import StellarCheckoutButton from "../../components/StellarCheckoutButton";
import StellarOrderWatch from "../../components/StellarOrderWatch";
import StellarWalletButton from "../../components/StellarWalletButton";
import Toast from "../../components/Toast";
import useToast from "../../hooks/useToast";
import sendMail from "../../lib/sendmail";
import type { SignedCheckoutQuote } from "../../lib/stellar/checkout";
import { validateAddress, validateEmail, validateName, validateOTP } from "../../lib/validation";

const Checkout = () => {
  const [otp] = useState<string>(() =>
    String(Math.floor(Math.random() * 1000000)).padStart(6, "0")
  );
  const [totalPrice, setTotalPrice] = useState(0);
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [stage, setStage] = useState(1);
  const [isOtpSending, setIsOtpSending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [enteredOtp, setEnteredOtp] = useState("");
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentQuote, setPaymentQuote] = useState<SignedCheckoutQuote | null>(null);
  const { toast, showToast, hideToast } = useToast(5000);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    address: "",
    subject: "MOVA STORE CHECKOUT VERIFICATION",
  });

  const [orderId] = useState(() => `SS-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const productIds = useMemo(
    () => cartItems.map((item) => item?.id).filter((id): id is string => typeof id === "string" && id.length > 0),
    [cartItems]
  );

  const clearPaidCart = () => {
    localStorage.removeItem("cartItems");
    localStorage.removeItem("itemCount");
    localStorage.removeItem("totalPrice");
  };

  const completePaidOrder = (message: string) => {
    if (paymentComplete) return;
    clearPaidCart();
    setPaymentComplete(true);
    showToast(message);
  };

  const handleStellarSuccess = (result: { amountUsd: number | string }) => {
    completePaidOrder(
      `USDC payment received ✓ $${Number(result.amountUsd).toFixed(2)} · order ${orderId}`
    );
  };

  const handleObservedPayment = () => {
    completePaidOrder(`USDC payment detected on-chain ✓ · order ${orderId}`);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormData((previous) => ({ ...previous, [name]: value }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const firstName = validateName(formData.firstName, "First name");
    const lastName = validateName(formData.lastName, "Last name");
    const email = validateEmail(formData.email);
    const address = validateAddress(formData.address);
    const invalid = [firstName, lastName, email, address].find((result) => !result.isValid);

    if (invalid) {
      showToast(invalid.error || "Please check your contact information.");
      return;
    }

    setIsSubmitting(true);
    try {
      await sendMail({
        name: `${firstName.sanitized} ${lastName.sanitized}`,
        email: email.sanitized || formData.email,
        message: `Verify your Mova Store checkout email with this OTP: ${otp}. This code does not authorize a payment.`,
        recipientEmail: email.sanitized || formData.email,
        subject: formData.subject,
      });
      setFormData((previous) => ({
        ...previous,
        firstName: firstName.sanitized || previous.firstName,
        lastName: lastName.sanitized || previous.lastName,
        email: email.sanitized || previous.email,
        address: address.sanitized || previous.address,
      }));
      setStage(2);
      showToast("Verification code sent. Payment has not been taken yet.");
    } catch {
      showToast("Failed to send the verification code. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEmailConfirmationSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isOtpSending) return;
    setIsOtpSending(true);

    const entered = enteredOtp.trim();
    const { isValid } = validateOTP(entered);
    if (isValid && entered === otp) {
      setIsOtpSending(false);
      setStage(3);
      showToast("Email verified. Merchant pricing will be verified before payment.");
      return;
    }

    setIsOtpSending(false);
    showToast("Incorrect OTP. Please try again.");
  };

  const handleGoBack = () => {
    if (stage > 1 && !paymentComplete) {
      setPaymentQuote(null);
      setStage((current) => current - 1);
      setIsSubmitting(false);
      setIsOtpSending(false);
    }
  };

  useEffect(() => {
    try {
      const storedItems = JSON.parse(localStorage.getItem("cartItems") || "[]");
      const storedTotalPrice = Number.parseFloat(localStorage.getItem("totalPrice") || "0");
      setCartItems(Array.isArray(storedItems) ? storedItems : []);
      setTotalPrice(Number.isFinite(storedTotalPrice) && storedTotalPrice > 0 ? storedTotalPrice : 0);
    } catch {
      setCartItems([]);
      setTotalPrice(0);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // Cart contents determine whether checkout can proceed. The local total is
  // display-only; the signed server quote is the sole payment authority.
  const isEmptyCart = isLoaded && !paymentComplete && cartItems.length === 0;
  const quotedUsd = paymentQuote ? paymentQuote.amountCents / 100 : null;

  if (isEmptyCart) {
    return (
      <div className="container mx-auto px-4 py-16 my-10 max-w-lg text-center bg-white rounded-lg shadow-md border-2 border-purple-300">
        <h2 className="text-2xl font-bold text-gray-800 mb-3">Your cart is empty</h2>
        <p className="text-gray-600 mb-6">
          Looks like you have not added any items to your cart yet. Please add items to proceed with checkout.
        </p>
        <Link href="/shop" className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-purple-700 hover:bg-purple-800 transition-colors">
          <MdArrowBack className="mr-2" /> Back to Shop
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="flex justify-center items-center space-x-2 my-4 sm:mx-0 mx-4 mt-16" aria-label="Checkout progress">
        {[1, 2, 3].map((step, index) => (
          <div className="contents" key={step}>
            {index > 0 && <span className={`w-20 h-1 sm:w-96 ${stage >= step ? "bg-purple-700" : "bg-gray-200"}`} />}
            <span className={`flex justify-center items-center w-8 h-8 sm:w-10 sm:h-10 border border-purple-700 rounded-full ${stage >= step ? "bg-purple-700 text-white" : "bg-white"}`} aria-label={`Step ${step}`}>
              {step}
            </span>
          </div>
        ))}
      </div>

      <div className="container mx-auto px-4 py-4 my-10 w-full bg-purple-400 rounded-md border-2 border-purple-700">
        <div className="flex flex-wrap -mx-4">
          <div className="w-full md:w-1/2 px-8 py-10 flex flex-col justify-center items-center text-center gap-5">
            <SiStellar size={92} className="text-purple-900" aria-hidden="true" />
            <div>
              <h2 className="text-2xl font-bold text-purple-950">Verified checkout, real payment</h2>
              <p className="mt-3 text-purple-950 max-w-md">
                Email verification confirms where we can reach you. It never counts as payment. Your order completes only after a merchant-priced Stellar USDC payment is confirmed.
              </p>
            </div>
            <div className="bg-white/80 border border-purple-700/30 rounded-md p-4 max-w-md text-sm text-gray-700">
              Mova Store does not collect card numbers or CVVs in this checkout. Cart totals stored in this browser are estimates only; the contract accepts only a short-lived signed catalog quote.
            </div>
          </div>

          <div className="w-full md:w-1/2 px-4 p-4 rounded-md">
            {stage === 1 && (
              <form onSubmit={handleSubmit} className="bg-white p-4 rounded shadow-md">
                <h2 className="text-2xl mb-2 text-center">Contact details</h2>
                <p className="text-sm text-gray-600 mb-4 text-center">Verify your email first. No payment is taken at this step.</p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="mb-4"><label htmlFor="firstName" className="block text-gray-700">First Name</label><input id="firstName" type="text" name="firstName" value={formData.firstName} onChange={handleChange} required autoComplete="given-name" className="w-full px-3 py-2 border rounded" /></div>
                  <div className="mb-4"><label htmlFor="lastName" className="block text-gray-700">Last Name</label><input id="lastName" type="text" name="lastName" value={formData.lastName} onChange={handleChange} required autoComplete="family-name" className="w-full px-3 py-2 border rounded" /></div>
                  <div className="mb-4"><label htmlFor="email" className="block text-gray-700">Email</label><input id="email" type="email" name="email" value={formData.email} onChange={handleChange} required autoComplete="email" className="w-full px-3 py-2 border rounded" /></div>
                  <div className="mb-4"><label htmlFor="address" className="block text-gray-700">Address</label><input id="address" type="text" name="address" value={formData.address} onChange={handleChange} required autoComplete="street-address" className="w-full px-3 py-2 border rounded" /></div>
                </div>
                <button type="submit" disabled={isSubmitting} className="w-full flex justify-center items-center bg-purple-600 text-white py-2 rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {isSubmitting ? <><AiOutlineLoading3Quarters className="animate-spin mr-2" />Sending verification code...</> : "Send verification code"}
                </button>
              </form>
            )}

            {stage === 2 && (
              <form onSubmit={handleEmailConfirmationSubmit} className="bg-white p-4 rounded shadow-md h-full space-y-8">
                <div><h2 className="text-2xl mb-2 text-center">Verify email</h2><p className="text-sm text-gray-600 text-center">Enter the six-digit code sent to {formData.email}. This verifies contact details only.</p></div>
                <div className="mb-4"><label htmlFor="otpConfirmation" className="block text-gray-700">Verification code</label><input id="otpConfirmation" type="text" name="otpConfirmation" value={enteredOtp} onChange={(event) => setEnteredOtp(event.target.value)} required maxLength={6} inputMode="numeric" pattern="[0-9]{6}" placeholder="000000" className="w-full px-3 py-2 border rounded" /></div>
                <button type="submit" disabled={isOtpSending} className="w-full bg-purple-600 text-white flex justify-center items-center py-2 rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{isOtpSending ? <><AiOutlineLoading3Quarters className="animate-spin mr-2" />Verifying...</> : "Verify email"}</button>
                <button type="button" onClick={handleGoBack} className="w-full flex justify-center items-center bg-gray-300 text-black py-2 rounded hover:bg-gray-400 transition-colors"><MdArrowBack className="mr-2" /> Edit contact details</button>
              </form>
            )}

            {stage === 3 && !paymentComplete && (
              <div className="bg-white p-4 rounded shadow-md flex flex-col gap-4">
                <div className="text-center">
                  <h2 className="text-2xl font-semibold">Pay with Stellar USDC</h2>
                  {quotedUsd !== null ? (
                    <p className="text-gray-700 mt-1 font-medium">Merchant quote: ${quotedUsd.toFixed(2)}</p>
                  ) : totalPrice > 0 ? (
                    <p className="text-gray-500 mt-1">Cart estimate: ${totalPrice.toFixed(2)} · merchant quote pending</p>
                  ) : (
                    <p className="text-gray-500 mt-1">Merchant quote will be loaded from the catalog.</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">Order {orderId}</p>
                </div>
                <StellarWalletButton />
                <StellarCheckoutButton productIds={productIds} orderId={orderId} onQuote={setPaymentQuote} onSuccess={handleStellarSuccess} />
                <StellarOrderWatch
                  orderId={orderId}
                  expectedAmountRaw={paymentQuote?.amountRaw || ""}
                  expectedTokenContractId={paymentQuote?.tokenContractId || ""}
                  enabled={Boolean(paymentQuote)}
                  onEvent={handleObservedPayment}
                />
                <p className="text-[11px] text-gray-500 text-center">
                  The order stays open until this exact signed merchant quote, order ID, token, and raw amount are confirmed on-chain. Browser-stored totals and email verification never clear your cart.
                </p>
                <button type="button" onClick={handleGoBack} className="w-full flex justify-center items-center bg-gray-300 text-black py-2 rounded hover:bg-gray-400 transition-colors"><MdArrowBack className="mr-2" /> Back to verification</button>
              </div>
            )}

            {paymentComplete && (
              <div className="bg-white p-6 rounded shadow-md min-h-80 flex flex-col justify-center items-center">
                <SiStellar size={56} className="text-green-600 mb-4" aria-hidden="true" />
                <h2 className="text-4xl mb-4 text-center font-bold">Payment confirmed.</h2>
                <p className="text-center">Your paid order {orderId} is complete.</p>
                <span className="text-center text-gray-600">Thanks for shopping with us.</span>
                <Link href="/shop" className="text-center mt-8 py-2 bg-purple-700 text-white hover:bg-purple-600 rounded-md px-4">Back to Shop</Link>
              </div>
            )}
          </div>
        </div>
      </div>
      <Toast message={toast.message} show={toast.show} onClose={hideToast} time={4000} />
    </>
  );
};

export default Checkout;
