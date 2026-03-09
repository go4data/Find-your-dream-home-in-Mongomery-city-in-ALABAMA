import pandas as pd
import numpy as np
import warnings

warnings.filterwarnings('ignore')

def impute_prices(file_name):
    print(f"Processing {file_name}...")
    df = pd.read_excel(file_name)
    
    # Identify price column (first column)
    price_col = df.columns[0]
    print(f"Price column identified as: {price_col}")
    
    # Make sure price is numeric, coercing errors to NaN
    if df[price_col].dtype == object:
        df[price_col] = df[price_col].astype(str).str.replace(r'[\$,]', '', regex=True)
        df[price_col] = df[price_col].replace('nan', np.nan)
    
    df[price_col] = pd.to_numeric(df[price_col], errors='coerce')
    
    missing_before = df[price_col].isna().sum()
    print(f"Missing prices before imputation: {missing_before}")
    
    if missing_before == 0:
        print("No missing prices. Skipping.\n")
        return
        
    # Group by Beds to get median and impute
    if 'Beds' in df.columns:
        beds_numeric = pd.to_numeric(df['Beds'], errors='coerce')
        df['Beds_tmp'] = beds_numeric
        df[price_col] = df.groupby('Beds_tmp')[price_col].transform(lambda x: x.fillna(x.median()))
        df.drop(columns=['Beds_tmp'], inplace=True)
        
    # Any remaining NaNs, fill with overall median
    overall_median = df[price_col].median()
    df[price_col] = df[price_col].fillna(overall_median)
    
    missing_after = df[price_col].isna().sum()
    print(f"Missing prices after imputation: {missing_after}")
    
    # Format prices logically - rent is typically integer, sale as well
    df[price_col] = df[price_col].round().astype(int)
    
    df.to_excel(file_name, index=False)
    print(f"Saved {file_name}\n")

if __name__ == "__main__":
    try:
        impute_prices('Hackthon_Rent.xlsx')
        impute_prices('Hackthon Gen AI-Mongamary_sale.xlsx')
    except Exception as e:
        print(f"Error: {e}")
