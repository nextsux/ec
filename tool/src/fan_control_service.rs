use ectool::{Access, AccessLpcLinux, Ec, Error as EcError, FanMode};
use std::{error::Error as StdError, fmt, sync::Mutex, time::Duration};
use zbus::{ConnectionBuilder, dbus_interface, fdo};

#[derive(Debug)]
struct FanControlError(EcError);

impl fmt::Display for FanControlError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Fan control error: {:?}", self.0)
    }
}

impl StdError for FanControlError {}

struct FanControl {
    ec: Mutex<Ec<Box<dyn Access>>>,
}

#[dbus_interface(name = "org.system76.FanControl")]
impl FanControl {
    fn set_speed(&self, speed: u8) -> Result<(), fdo::Error> {
        let mut ec = self
            .ec
            .lock()
            .map_err(|_| fdo::Error::Failed("Failed to acquire lock on EC".to_string()))?;

        unsafe {
            ec.fan_set_pwm(1, speed)
                .map_err(|e| fdo::Error::Failed(format!("Failed to set fan speed: {:?}", e)))?;
        }
        Ok(())
    }

    fn get_speed(&self) -> Result<u8, fdo::Error> {
        let mut ec = self
            .ec
            .lock()
            .map_err(|_| fdo::Error::Failed("Failed to acquire lock on EC".to_string()))?;

        unsafe {
            ec.fan_get_pwm(1)
                .map_err(|e| fdo::Error::Failed(format!("Failed to get fan speed: {:?}", e)))
        }
    }

    // Added function to set fan mode (PWM or AUTO)
    fn set_mode(&self, mode: String) -> Result<(), fdo::Error> {
        let mut ec = self
            .ec
            .lock()
            .map_err(|_| fdo::Error::Failed("Failed to acquire lock on EC".to_string()))?;

        // Convert the string to FanMode
        let fan_mode = match mode.to_lowercase().as_str() {
            "auto" => FanMode::Auto,
            "pwm" => FanMode::Pwm,
            _ => return Err(fdo::Error::Failed(format!("Invalid fan mode: {}", mode))),
        };

        unsafe {
            ec.fan_set_mode(fan_mode)
                .map_err(|e| fdo::Error::Failed(format!("Failed to set fan mode: {:?}", e)))?;
        }
        Ok(())
    }

    // Added function to get the current fan mode
    fn get_mode(&self) -> Result<String, fdo::Error> {
        let mut ec = self
            .ec
            .lock()
            .map_err(|_| fdo::Error::Failed("Failed to acquire lock on EC".to_string()))?;

        unsafe {
            let mode = ec
                .fan_get_mode()
                .map_err(|e| fdo::Error::Failed(format!("Failed to get fan mode: {:?}", e)))?;

            // Convert FanMode to string
            let mode_str = match mode {
                FanMode::Auto => "auto",
                FanMode::Pwm => "pwm",
                FanMode::Rpm => "rpm",
            };

            Ok(mode_str.to_string())
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn StdError>> {
    let ec = unsafe {
        let access = AccessLpcLinux::new(Duration::new(1, 0)).map_err(FanControlError)?;
        Ec::new(access).map_err(FanControlError)?.into_dyn()
    };

    let fan_control = FanControl { ec: Mutex::new(ec) };

    let _connection = ConnectionBuilder::system()?
        .name("org.system76.FanControl")?
        .serve_at("/org/system76/FanControl", fan_control)?
        .build()
        .await?;

    // Keep the service running
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
